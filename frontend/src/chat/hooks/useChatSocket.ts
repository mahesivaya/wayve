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

  useEffect(() => {
    if (!user) {
      const timeout = window.setTimeout(() => setReadyState(WebSocket.CLOSED), 0);
      return () => window.clearTimeout(timeout);
    }

    const ws = new WebSocket(`${getWsBase()}/ws/chat`);
    wsRef.current = ws;
    const initialStateTimeout = window.setTimeout(
      () => setReadyState(ws.readyState),
      0,
    );

    ws.onopen = () => {
      setReadyState(ws.readyState);
      logger.log("✅ WS connected");
    };

    ws.onmessage = (event) => {
      const msg: ChatMessage & { type?: string } = JSON.parse(event.data);
      if (msg.type === "status_update" || msg.sender_id === user.id) return;

      if (messageBelongsToSelectedConversation(msg, selectedRef.current)) {
        void onMessage(msg);
      }
    };

    ws.onclose = () => {
      setReadyState(ws.readyState);
      logger.log("❌ WS disconnected");
    };

    ws.onerror = () => {
      setReadyState(ws.readyState);
    };

    return () => {
      window.clearTimeout(initialStateTimeout);
      window.setTimeout(() => setReadyState(WebSocket.CLOSED), 0);
      ws.close();
    };
  }, [onMessage, selectedRef, user]);

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
