import { apiFetchJson } from "./client";

// ---- Types -----------------------------------------------------------------

export type PlanTier = "personal" | "startups" | "business" | "enterprise";

export type Plan = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  audience: "personal" | "organization";
  // Sub-tier within the audience; distinguishes Business from Enterprise.
  tier: PlanTier;
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
  members: {
    id: number;
    email: string;
    account_type: string;
    role?: string | null;
  }[];
};

// ---- Calls -----------------------------------------------------------------

// Billing routes use `preserve401: true` so a credentials issue surfaces as a
// throw at the call site instead of bouncing the user to /login mid-flow.
const json = <T>(path: string, options?: RequestInit) =>
  apiFetchJson<T>(path, { preserve401: true, ...options });

export const listPlans = () => json<Plan[]>("/api/billing/plans");

// ---- Platform admin: plan management --------------------------------------

export type UpsertPlanInput = {
  code: string;
  name: string;
  description?: string | null;
  audience: "personal" | "organization";
  tier?: PlanTier;
  stripe_price_id?: string | null;
  amount_cents: number;
  currency: string;
  billing_interval: string;
  storage_limit_bytes: number;
  seat_limit: number;
  features?: Record<string, unknown>;
  is_active?: boolean;
};

/** Returns ALL plans including deactivated ones — only platform admins may call. */
export const adminListPlans = () => json<Plan[]>("/api/billing/admin/plans");

/**
 * Create or update a plan by `code`. Same payload shape for both — the
 * server upserts on the unique `code` column. Returns the persisted row.
 */
export const adminUpsertPlan = (input: UpsertPlanInput) =>
  json<Plan>("/api/billing/admin/plans", {
    method: "POST",
    body: JSON.stringify(input),
  });

/**
 * Soft-delete (sets is_active=false). The row stays so historical
 * subscriptions that still reference it stay resolvable; it just stops
 * appearing on /pricing.
 */
export const adminDeactivatePlan = async (code: string) => {
  await json<void>(`/api/billing/admin/plans/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
};

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

// In-page subscription: returns a PaymentIntent client_secret the caller
// mounts a Stripe Payment Element with. No redirect to checkout.stripe.com.
// The subscription is created in `incomplete` state and flips to `active`
// once the frontend's confirmPayment succeeds + Stripe webhooks land.
export const startInlineSubscription = (planCode: string, autopay = true) =>
  json<{
    subscription_id: string;
    client_secret: string;
    publishable_key: string | null;
  }>("/api/billing/subscriptions", {
    method: "POST",
    body: JSON.stringify({ plan_code: planCode, autopay }),
  });

export const openBillingPortal = () =>
  json<{ url: string }>("/api/billing/portal", { method: "POST" });

export const createPaymentMethodSetupIntent = () =>
  json<{ client_secret: string }>("/api/billing/payment-method/setup-intent", {
    method: "POST",
  });

export const setDefaultPaymentMethod = (paymentMethodId: string) =>
  json<{ saved: boolean }>("/api/billing/payment-method/default", {
    method: "POST",
    body: JSON.stringify({ payment_method_id: paymentMethodId }),
  });

export const cancelSubscription = () =>
  json<{ cancel_at_period_end: boolean }>("/api/billing/subscription", {
    method: "DELETE",
  });

export const getStripeStatus = () =>
  json<StripeStatus>("/api/billing/provider-status");

export type DefaultCard = {
  payment_method_id: string;
  brand: string;
  last4: string;
};

// The requesting owner's saved default card, or null when none is on file
// (e.g. a Basic user who has never paid). Drives the "use saved card" radio
// on the org create form.
export const getDefaultPaymentMethod = () =>
  json<{ default: DefaultCard | null }>("/api/billing/payment-method/default");
