import { apiFetchJson } from "./client";

export type AiTurn = {
  role: "user" | "model";
  content: string;
};

export type AiToolUsed = { name: string; connection_label: string };

// The backend resolves the provider/model per request and returns them alongside
// the reply, so the UI can label itself with the real provider instead of a
// hard-coded "Gemini". `provider` is the id ("gemini" | "anthropic" |
// "openai_compatible"); never the API key.
export type AiChatResponse = {
  reply?: string;
  provider?: string | null;
  model?: string | null;
  tools_used?: AiToolUsed[];
};

export const sendAiChat = async (messages: AiTurn[]) =>
  apiFetchJson<AiChatResponse>("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });

export type AiProviderInfo = {
  provider: string | null;
  model: string | null;
};

// Resolved provider/model for the current user, so the assistant header can show
// the truth on load (before any message). No secrets — safe for all members.
export const getAiProvider = async () =>
  apiFetchJson<AiProviderInfo>("/api/ai/provider");
