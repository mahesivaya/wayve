import { apiFetchJson } from "./client";

export type ApiTier = {
  code: string;
  name: string;
  audience: "personal" | "organization";
  amount_cents: number;
  currency: string;
  billing_interval: string;
  rate_limit_per_min: number;
  /** -1 means unlimited. */
  monthly_quota: number;
};

export type QuotaStatus = {
  plan_code: string;
  plan_name: string;
  rate_limit_per_min: number;
  monthly_quota: number;
  monthly_used: number | null;
  monthly_remaining: number | null;
  cycle_resets_at: string;
};

export const listTiers = () =>
  apiFetchJson<ApiTier[]>("/api/billing/tiers", { auth: false });

export const getQuota = () => apiFetchJson<QuotaStatus>("/api/billing/quota");
