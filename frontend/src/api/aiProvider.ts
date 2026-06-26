import { apiFetch, apiFetchJson } from "./client";

// The org's AI provider, selected by the enterprise owner. The API key is never
// returned — only `has_key` reflects whether one is stored.
export type AiProviderId = "gemini" | "anthropic" | "openai_compatible";

export type AiConfig = {
  configured: boolean;
  provider: AiProviderId | null;
  base_url: string | null;
  model: string | null;
  fail_closed: boolean;
  enabled: boolean;
  has_key: boolean;
  last_validated_at: string | null;
};

// A selectable provider block, returned by the backend so the UI catalog stays
// in lockstep with what the server actually supports.
export type AiProviderOption = {
  id: AiProviderId;
  label: string;
  vendor: string;
  default_model: string;
  needs_base_url: boolean;
};

export type AiConfigResponse = {
  config: AiConfig;
  providers: AiProviderOption[];
};

export const getAiConfig = async () =>
  apiFetchJson<AiConfigResponse>("/api/ai/config");

export const putAiConfig = async (payload: {
  provider: AiProviderId;
  model?: string;
  base_url?: string;
  // Omit to keep the stored key; "" clears it (Gemini → platform key).
  api_key?: string;
  fail_closed: boolean;
}) =>
  apiFetchJson<AiConfig>("/api/ai/config", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteAiConfig = async () => {
  await apiFetch("/api/ai/config", { method: "DELETE" });
};

// ── Usage & cost governance (sample data for now) ──────────────────────────
export type AiUsage = {
  sample: boolean;
  provider: string;
  model: string | null;
  period: string;
  totals: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cost_cents: number;
    active_users: number;
  };
  budget: {
    monthly_limit_cents: number;
    spent_cents: number;
    alert_threshold_pct: number;
  };
  daily: { day: string; requests: number; cost_cents: number }[];
  by_model: { model: string; requests: number; cost_cents: number }[];
  by_member: { name: string; requests: number; cost_cents: number }[];
};

export const getAiUsage = async () => apiFetchJson<AiUsage>("/api/ai/usage");
