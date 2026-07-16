import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatMessage, ChatStatus, ReactionGroup } from "../../api/chat";
import { getWsBase } from "../../config/env";
import { logger } from "../../utils/logger";
import type { Conversation } from "../types";

type User = {
  id: number;
};

export function useChatSocket(
  user: User | null | undefined,
  selectedRef: RefObject<Conversation | null>,
  onMessage: (message: ChatMessage) => void | Promise<void>,
  // Fires on every (re)open, so the caller can backfill messages missed while the
  // socket was down.
  onOpen?: () => void,
  // Advances a sent message's delivery tick (sent → delivered → read).
  onStatusUpdate?: (messageId: number, status: ChatMessage["status"]) => void,
  // Fires for any inbound message from someone else, in any conversation, so the
  // caller can refresh unread counts and recency for the whole list.
  onInbound?: (message: ChatMessage) => void,
  onPresence?: (
    userId: number,
    online: boolean,
    lastSeen: string | null,
    status: ChatStatus
  ) => void,
  // Carries the message's full reaction set, not a delta, so a client that missed
  // a frame still converges.
  onReaction?: (
    messageId: number,
    isChannel: boolean,
    reactions: ReactionGroup[]
  ) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);
  // Distinct from "not connected": true while a reconnect is in flight, so the UI
  // can show "reconnecting…" rather than a dead composer.
  const [reconnecting, setReconnecting] = useState(false);

  // Handlers are read through refs so the connect effect depends only on the user
  // identity. Otherwise the socket would tear down and reconnect every time a
  // handler changed identity, churn that can leave the composer disabled.
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onStatusUpdateRef = useRef(onStatusUpdate);
  const onInboundRef = useRef(onInbound);
  const onPresenceRef = useRef(onPresence);
  const onReactionRef = useRef(onReaction);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate;
  }, [onStatusUpdate]);
  useEffect(() => {
    onInboundRef.current = onInbound;
  }, [onInbound]);
  useEffect(() => {
    onPresenceRef.current = onPresence;
  }, [onPresence]);
  useEffect(() => {
    onReactionRef.current = onReaction;
  }, [onReaction]);

  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;

    // Only this run may update state: a stale socket's late close/error must never
    // flip state after a newer socket has opened.
    let cancelled = false;
    // Auto-reconnect bookkeeping. An idle socket killed by nginx's
    // proxy_read_timeout would otherwise stay closed, disabling the composer until
    // a full reload.
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;

      const ws = new WebSocket(`${getWsBase()}/ws/chat`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0; // reset backoff on a successful connect
        setReadyState(ws.readyState);
        setReconnecting(false);
        logger.log("✅ WS connected");
        onOpenRef.current?.();
      };

      ws.onmessage = (event) => {
        const msg: ChatMessage & {
          type?: string;
          user_id?: number;
          online?: boolean;
          last_seen?: string | null;
          is_channel?: boolean;
          reactions?: ReactionGroup[];
        } = JSON.parse(event.data);
        // Non-chat broadcasts (such as the Gmail-push nudge) ride the same per-user
        // fan-out. Ignore them so they are never handled as inbound messages.
        if (msg.type?.startsWith("email:")) return;
        if (msg.type === "presence") {
          if (typeof msg.user_id === "number") {
            // `status` is presence-specific and collides with ChatMessage's
            // own delivery `status`, so read it off a narrow local cast.
            const presenceStatus =
              (msg as unknown as { status?: ChatStatus }).status ?? "active";
            onPresenceRef.current?.(
              msg.user_id,
              !!msg.online,
              msg.last_seen ?? null,
              presenceStatus
            );
          }
          return;
        }
        if (msg.type === "status_update") {
          if (msg.message_id != null && msg.status) {
            onStatusUpdateRef.current?.(msg.message_id, msg.status);
          }
          return;
        }
        // Must be handled before the self-echo drop below, which would otherwise
        // swallow our own reaction: a reaction frame has no client_id and its
        // sender_id is undefined.
        if (msg.type === "reaction_updated") {
          if (msg.message_id != null) {
            onReactionRef.current?.(
              msg.message_id,
              !!msg.is_channel,
              msg.reactions ?? []
            );
          }
          return;
        }
        // A self-broadcast without a client_id is legacy or multi-tab, and the
        // optimistic local copy already covers it. One WITH a client_id is the
        // reconciliation echo, so pass it through to patch the optimistic copy with
        // the server-assigned message_id.
        if (msg.sender_id === userId && !msg.client_id) return;

        // Self-echoes are excluded so we never bump our own unread count.
        if (msg.sender_id !== userId) {
          onInboundRef.current?.(msg);
        }

        if (messageBelongsToSelectedConversation(msg, selectedRef.current)) {
          // Send a read receipt only if the user is actually looking. A message that
          // lands while the window is backgrounded stays "delivered" and is marked
          // read by the focus/visibility flush below. DMs only: channels have no
          // read state. The backend UPDATE is idempotent.
          if (
            !msg.channel_id &&
            msg.sender_id !== userId &&
            isActivelyViewing()
          ) {
            sendReadReceipt(ws, userId, msg.sender_id);
          }
          void onMessageRef.current(msg);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setReadyState(ws.readyState);
        setReconnecting(true);
        // Capped exponential backoff with ±20% jitter, so a herd of clients does not
        // reconnect in lockstep after a server blip.
        attempts += 1;
        const base = Math.min(1000 * 2 ** (attempts - 1), 15000);
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        const delay = Math.max(500, Math.round(base + jitter));
        logger.log(`❌ WS disconnected — reconnecting in ${delay}ms`);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (cancelled) return;
        setReadyState(ws.readyState);
        // `onclose` fires right after and owns the reconnect scheduling.
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setReadyState(WebSocket.CLOSED);
      setReconnecting(false);
      wsRef.current?.close();
    };
  }, [userId, selectedRef]);

  // Read-receipt flush on focus/visibility, covering messages that arrived while
  // the window was backgrounded, which the inbound handler deliberately skipped so
  // that "read" means actually seen. One receipt marks everything unread from that
  // sender, so a single send suffices.
  useEffect(() => {
    if (!userId) return;
    const flushRead = () => {
      if (!isActivelyViewing()) return;
      const convo = selectedRef.current;
      const ws = wsRef.current;
      if (convo?.type === "user" && ws) {
        sendReadReceipt(ws, userId, convo.user.id);
      }
    };
    window.addEventListener("focus", flushRead);
    document.addEventListener("visibilitychange", flushRead);
    return () => {
      window.removeEventListener("focus", flushRead);
      document.removeEventListener("visibilitychange", flushRead);
    };
  }, [userId, selectedRef]);

  return {
    wsRef,
    isConnected: readyState === WebSocket.OPEN,
    isReconnecting: reconnecting,
  };
}

/** True only when the user is actually looking: tab visible AND window focused. */
function isActivelyViewing() {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/**
 * Marks every message `otherId` sent us as read. The empty `content` and our own
 * `sender_id` only satisfy the ChatMessage schema: the backend's read handler
 * never reads the content and derives the reader from the authenticated session.
 */
function sendReadReceipt(ws: WebSocket, readerId: number, otherId: number) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      sender_id: readerId,
      receiver_id: otherId,
      content: "",
      status: "read",
    })
  );
}

function messageBelongsToSelectedConversation(
  msg: ChatMessage,
  conversation: Conversation | null
) {
  if (conversation?.type === "channel") {
    return msg.channel_id === conversation.channel.id;
  }

  return (
    conversation?.type === "user" &&
    !msg.channel_id &&
    (msg.sender_id === conversation.user.id ||
      msg.receiver_id === conversation.user.id)
  );
}
