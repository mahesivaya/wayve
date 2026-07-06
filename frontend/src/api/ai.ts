import { apiFetchJson } from "./client";

export type AiTurn = {
  role: "user" | "model";
  content: string;
};

export type AiToolUsed = { name: string; connection_label: string };

// An action the assistant proposed but did NOT perform. The assistant only ever
// drafts outward/irreversible actions (e.g. sending an email); the browser
// executes them through the existing authenticated endpoint after the user
// confirms. Mirrors the backend `PendingAction` enum (tagged by `type`).
export type PendingEmail = {
  type: "email";
  to: string;
  subject: string;
  body: string;
  account_id?: number;
};

export type PendingAction = PendingEmail;

// The backend resolves the provider/model per request and returns them alongside
// the reply, so the UI can label itself with the real provider instead of a
// hard-coded "Gemini". `provider` is the id ("gemini" | "anthropic" |
// "openai_compatible"); never the API key.
export type AiChatResponse = {
  reply?: string;
  provider?: string | null;
  model?: string | null;
  tools_used?: AiToolUsed[];
  pending_actions?: PendingAction[];
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
