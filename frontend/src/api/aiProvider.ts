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

// ── AI data access (platform team only) ────────────────────────────────────
// Which categories of the user's own Wayve data the platform assistant's native
// tools may read. Only the categories with native tools today are enforceable
// (email, calendar); the endpoint is platform-owner-only. Reading before a
// provider is configured returns the open defaults; saving requires a provider.
export type AiDataAccess = {
  email: boolean;
  calendar: boolean;
};

export const getAiDataAccess = async () =>
  apiFetchJson<AiDataAccess>("/api/ai/data-access");

export const putAiDataAccess = async (payload: AiDataAccess) =>
  apiFetchJson<AiDataAccess>("/api/ai/data-access", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

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

// Authoritative spend billed by Anthropic (Admin Cost API), as opposed to the
// local per-turn estimate in AiUsage. Platform-owner only; the endpoint 403s
// for org owners and returns { configured: false } when no admin key is set.
export type AnthropicCost = {
  configured: boolean;
  period?: string;
  currency?: string;
  total_cents?: number;
  by_model?: { model: string; cost_cents: number }[];
  truncated?: boolean;
};

export const getAnthropicCost = async () =>
  apiFetchJson<AnthropicCost>("/api/ai/anthropic-cost");
