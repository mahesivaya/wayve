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
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);

  // Read the latest message handler through a ref so the connect effect below
  // depends only on the user identity. Without this, the socket would tear
  // down and reconnect every time `onMessage` (which depends on transient UI
  // state like the open thread) changed identity — and the reconnect churn
  // could leave `readyState` stuck non-OPEN, disabling the composer.
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const userId = user?.id;

  useEffect(() => {
    // No user → no socket. State is already CLOSED here: it's the initial
    // value, and any prior run's cleanup set it CLOSED on the way out.
    if (!userId) return;

    // Only this run's socket may update `readyState`. A stale socket's late
    // close/error (or the cleanup below) must never flip state after a newer
    // socket has already opened — that race was the "stuck disconnected" bug.
    let cancelled = false;

    const ws = new WebSocket(`${getWsBase()}/ws/chat`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      setReadyState(ws.readyState);
      logger.log("✅ WS connected");
    };

    ws.onmessage = (event) => {
      const msg: ChatMessage & { type?: string } = JSON.parse(event.data);
      if (msg.type === "status_update") return;
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
      logger.log("❌ WS disconnected");
    };

    ws.onerror = () => {
      if (cancelled) return;
      setReadyState(ws.readyState);
    };

    return () => {
      cancelled = true;
      setReadyState(WebSocket.CLOSED);
      ws.close();
    };
  }, [userId, selectedRef]);

  return {
    wsRef,
    isConnected: readyState === WebSocket.OPEN,
  };
}

function messageBelongsToSelectedConversation(
  msg: ChatMessage,
  conversation: Conversation | null,
) {
  if (conversation?.type === "channel") {
    return msg.channel_id === conversation.channel.id;
  }

  return (
    conversation?.type === "user" &&
    !msg.channel_id &&
    (msg.sender_id === conversation.user.id || msg.receiver_id === conversation.user.id)
  );
}
