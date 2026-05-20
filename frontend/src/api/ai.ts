import { apiFetchJson } from "./client";

export type AiTurn = {
  role: "user" | "model";
  content: string;
};

export const sendAiChat = async (messages: AiTurn[]) =>
  apiFetchJson<{ reply?: string }>("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
