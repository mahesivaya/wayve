import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatMessage } from "../../api/chat";
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
  onStatusUpdate?: (messageId: number, status: ChatMessage["status"]) => void
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
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate;
  }, [onStatusUpdate]);

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
        const msg: ChatMessage & { type?: string } = JSON.parse(event.data);
        // Delivery-tick update for one of our sent messages (sent → delivered
        // → read). Patch the bubble's status in place; not a new message.
        if (msg.type === "status_update") {
          if (msg.message_id != null && msg.status) {
            onStatusUpdateRef.current?.(msg.message_id, msg.status);
          }
          return;
        }
        // Self-broadcasts without a client_id are legacy/multi-tab and we drop
        // them — the optimistic local copy already covers the same-tab case.
        // Self-broadcasts WITH a client_id are the reconciliation echo: pass
        // them through so appendRealtimeMessage can patch the optimistic copy
        // with the server-assigned message_id.
        if (msg.sender_id === userId && !msg.client_id) return;

        if (messageBelongsToSelectedConversation(msg, selectedRef.current)) {
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

  return {
    wsRef,
    isConnected: readyState === WebSocket.OPEN,
    isReconnecting: reconnecting,
  };
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
