import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatMessage, ReactionGroup } from "../../api/chat";
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
  // Called every time the socket (re)opens — used to backfill any messages
  // missed while the socket was down (Tier 2 resync). Optional.
  onOpen?: () => void,
  // Called for a `status_update` event ({message_id, status}) so the sender's
  // bubble can advance its delivery tick (sent → delivered → read). Optional.
  onStatusUpdate?: (messageId: number, status: ChatMessage["status"]) => void,
  // Called for any inbound real message (not status_update, not a self-echo),
  // regardless of which conversation it belongs to — lets the caller refresh
  // unread counts / recency for the whole list, not just the open chat.
  onInbound?: (message: ChatMessage) => void,
  // Called for a `presence` event ({user_id, online, last_seen}) so the caller
  // can flip a contact's online dot live. Optional.
  onPresence?: (
    userId: number,
    online: boolean,
    lastSeen: string | null
  ) => void,
  // Called for a `reaction_updated` event so the caller can patch the message's
  // reaction pills. Carries the message's FULL reaction set (not a delta), so a
  // client that missed a frame still converges. Optional.
  onReaction?: (
    messageId: number,
    isChannel: boolean,
    reactions: ReactionGroup[]
  ) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);
  // Distinct from "not connected": true while we're actively trying to come
  // back after a drop, so the UI can show "reconnecting…" rather than a dead
  // composer.
  const [reconnecting, setReconnecting] = useState(false);

  // Read the latest handlers through refs so the connect effect below depends
  // only on the user identity. Without this, the socket would tear down and
  // reconnect every time `onMessage`/`onOpen` (which depend on transient UI
  // state) changed identity — churn that could leave the composer disabled.
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
    // No user → no socket. State is already CLOSED here: it's the initial
    // value, and any prior run's cleanup set it CLOSED on the way out.
    if (!userId) return;

    // Only this run's effect may update state. A stale socket's late
    // close/error (or the cleanup below) must never flip state after a newer
    // socket has already opened — that race was the original "stuck
    // disconnected" bug.
    let cancelled = false;
    // Auto-reconnect bookkeeping. Without this, an idle socket killed by the
    // proxy (nginx closes idle WS after proxy_read_timeout) stays closed
    // forever, leaving the composer permanently disabled until a full reload
    // ("after some time the textbox disables" bug).
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
        // Backfill anything missed while we were down (Tier 2 resync).
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
        // Non-chat broadcasts (e.g. the Gmail-push `email:new` nudge) ride the
        // same per-user socket fan-out. The chat page ignores them so they're
        // never mis-handled as inbound messages.
        if (msg.type?.startsWith("email:")) return;
        // A contact came online / went offline — flip their dot live.
        if (msg.type === "presence") {
          if (typeof msg.user_id === "number") {
            onPresenceRef.current?.(
              msg.user_id,
              !!msg.online,
              msg.last_seen ?? null
            );
          }
          return;
        }
        // Delivery-tick update for one of our sent messages (sent → delivered
        // → read). Patch the bubble's status in place; not a new message.
        if (msg.type === "status_update") {
          if (msg.message_id != null && msg.status) {
            onStatusUpdateRef.current?.(msg.message_id, msg.status);
          }
          return;
        }
        // Someone reacted (possibly us — the server echoes our own reaction back
        // rather than us guessing optimistically). Must be handled BEFORE the
        // self-echo drop below, which would otherwise swallow our own reaction:
        // a reaction frame has no client_id, and its sender_id is undefined.
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
        // Self-broadcasts without a client_id are legacy/multi-tab and we drop
        // them — the optimistic local copy already covers the same-tab case.
        // Self-broadcasts WITH a client_id are the reconciliation echo: pass
        // them through so appendRealtimeMessage can patch the optimistic copy
        // with the server-assigned message_id.
        if (msg.sender_id === userId && !msg.client_id) return;

        // Inbound message from someone else (any conversation): let the caller
        // refresh unread/recency for the whole list. Self-echoes (our own sends
        // reconciling) are excluded so we don't bump our own unread.
        if (msg.sender_id !== userId) {
          onInboundRef.current?.(msg);
        }

        if (messageBelongsToSelectedConversation(msg, selectedRef.current)) {
          // Inbound DM for the conversation we're viewing → send a read receipt,
          // but only if we're ACTUALLY looking (tab visible + window focused).
          // WhatsApp-style: a message that lands while the window is backgrounded
          // stays ✓✓ (delivered) and is marked read later by the focus/visibility
          // flush below, when the recipient brings the window forward. DMs only —
          // channels have no read state. The UPDATE is idempotent, so per-message
          // sends are cheap.
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
        // Reconnect with capped exponential backoff + jitter (±20%) so a
        // thundering herd of clients doesn't reconnect in lockstep after a
        // server blip. ~1s, 2s, 4s … capped at 15s.
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

  // Read-receipt flush on focus/visibility. When the window regains focus or
  // becomes visible and a DM conversation is open, mark its messages read — this
  // covers messages that arrived while the window was backgrounded (the inbound
  // handler above deliberately skipped them so "read" means actually-seen). The
  // backend UPDATE marks all unread-from-that-sender, so one receipt suffices.
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
 * Send a read receipt over the socket: marks every message `otherId` sent to us
 * as read. `content`/`sender_id` are required for the backend to parse this as a
 * ChatMessage; the read handler returns before reading content and derives the
 * reader from the authenticated session, so the empty content and our own id
 * here just satisfy the schema.
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
