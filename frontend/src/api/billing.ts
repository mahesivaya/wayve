import { apiFetch } from "./client";

// ---- Types -----------------------------------------------------------------

export type Plan = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  audience: "personal" | "organization";
  stripe_price_id: string | null;
  amount_cents: number;
  currency: string;
  billing_interval: string;
  storage_limit_bytes: number;
  seat_limit: number;
  features: Record<string, unknown>;
  is_active: boolean;
};

export type SubscriptionSummary = {
  id: number;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  plan_code: string | null;
  plan_name: string | null;
  amount_cents: number | null;
  currency: string | null;
  billing_interval: string | null;
};

export type SubscriptionResponse = {
  owner_type: "personal" | "organization";
  subscription: SubscriptionSummary | null;
};

export type Entitlements = {
  owner_type: "personal" | "organization";
  plan_code: string | null;
  storage_limit_bytes: number;
  seat_limit: number;
  features: Record<string, unknown>;
  active: boolean;
};

export type Invoice = {
  id: number;
  stripe_invoice_id: string;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  status: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  created_at: string;
};

export type UsageMetric = { metric: string; total: number; events: number };
export type UsageResponse = {
  owner_type: "personal" | "organization";
  metrics: UsageMetric[];
};

export type StripeStatus = {
  configured: boolean;
  test_mode: boolean;
  country: string;
  publishable_key: string;
};

export type OrganizationBilling = {
  organization: { id: number; name: string; slug: string | null };
  can_manage: boolean;
  seats_used: number;
  seat_limit: number;
  storage_limit_bytes: number;
  plan_code: string | null;
  plan_active: boolean;
  subscription: {
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    plan_code: string | null;
  } | null;
  members: { id: number; email: string; account_type: string; role?: string | null }[];
};

// ---- Calls -----------------------------------------------------------------

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(path, { preserve401: true, ...options });
  return res.json() as Promise<T>;
}

export const listPlans = () => json<Plan[]>("/api/billing/plans");

export const getSubscription = () =>
  json<SubscriptionResponse>("/api/billing/subscription");

export const getEntitlements = () =>
  json<Entitlements>("/api/billing/entitlements");

export const listInvoices = () => json<Invoice[]>("/api/billing/invoices");

export const getUsage = () => json<UsageResponse>("/api/billing/usage");

export const getOrganizationBilling = () =>
  json<OrganizationBilling>("/api/billing/organization");

export const startCheckout = (planCode: string, autopay = true) =>
  json<{ url: string; session_id: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan_code: planCode, autopay }),
  });

export const openBillingPortal = () =>
  json<{ url: string }>("/api/billing/portal", { method: "POST" });

export const cancelSubscription = () =>
  json<{ cancel_at_period_end: boolean }>("/api/billing/subscription/cancel", {
    method: "POST",
  });

export const getStripeStatus = () =>
  json<StripeStatus>("/api/billing/stripe-status");
