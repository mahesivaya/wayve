import { apiFetchJson } from "./client";

export type AiTurn = {
  role: "user" | "model";
  content: string;
};

export type AiToolUsed = { name: string; connection_label: string };

// An action the assistant proposed but did not perform: it only ever drafts
// outward or irreversible actions, and the browser executes them through the
// normal authenticated endpoint once the user confirms. Mirrors the backend
// `PendingAction` enum, tagged by `type`.
export type PendingEmail = {
  type: "email";
  to: string;
  subject: string;
  body: string;
  account_id?: number;
};

export type PendingAction = PendingEmail;

// The backend resolves provider and model per request and returns them with the
// reply, so the UI can label itself accurately. `provider` is the id, never the
// API key.
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

// Lets the assistant header show the real provider on load, before any message
// is sent. It returns no secrets and is safe for all members.
export const getAiProvider = async () =>
  apiFetchJson<AiProviderInfo>("/api/ai/provider");
