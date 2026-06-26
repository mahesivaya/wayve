// Single source of truth for plan DISPLAY data in the UI. Mirrors the backend
// catalog `backend/crates/wayve-server/src/billing/catalog.rs` (which seeds the
// `plans` table). The in-app pricing/billing CARDS already render live from the
// API (`/api/billing/plans`); this file backs only the things that can't fetch
// it — the logged-out marketing page and the code→name labels.
//
// To change pricing/plans, edit THIS file and `billing/catalog.rs`.

export type PlanTier = {
  /** DB plan code (matches catalog.rs `code`). */
  code: string;
  name: string;
  audience: "personal" | "organization";
  tier: "personal" | "startups" | "business" | "enterprise";
  /** Marketing price display, e.g. "Free", "7.00 USD". */
  price: string;
  interval: string | null;
  tagline: string;
  features: string[];
  cta: string;
};

export const PLAN_CATALOG: PlanTier[] = [
  {
    code: "basic_user",
    name: "Free Personal",
    audience: "personal",
    tier: "personal",
    price: "Free",
    interval: null,
    tagline: "Free plan for individual accounts.",
    features: [
      "1 GB encrypted storage",
      "Up to 1,000 emails per day",
      "End-to-end encrypted chat",
      "1 seat",
    ],
    cta: "Get started",
  },
  {
    code: "advance_user",
    name: "Advanced Personal",
    audience: "personal",
    tier: "personal",
    price: "7.00 USD",
    interval: "month",
    tagline: "Paid personal plan with higher limits.",
    features: [
      "10 GB encrypted storage",
      "Unlimited daily emails",
      "1,000 encrypt/decrypt ops per day",
      "Priority email sync",
    ],
    cta: "Choose plan",
  },
  {
    code: "business_startups",
    name: "Free Organization",
    audience: "organization",
    tier: "startups",
    price: "Free",
    interval: null,
    tagline: "Free plan for small teams to evaluate org features.",
    features: [
      "Up to 5 members",
      "5 GB shared storage",
      "Shared org workspace",
      "Admin & billing controls",
    ],
    cta: "Get started",
  },
  {
    code: "organization",
    name: "Advanced Organization",
    audience: "organization",
    tier: "business",
    price: "12.00 USD",
    interval: "user / month",
    tagline: "For growing organizations up to 100 members.",
    features: [
      "Up to 100 members",
      "Unlimited storage & email",
      "SSO + role-based access",
      "Audit logs & priority support",
    ],
    cta: "Choose plan",
  },
  {
    code: "enterprise",
    name: "Enterprise",
    audience: "organization",
    tier: "enterprise",
    price: "49.00 USD",
    interval: "user / month",
    tagline: "100+ members with unlimited everything.",
    features: [
      "Unlimited members",
      "Dedicated success manager",
      "Custom onboarding & SLA",
      "SSO, SCIM & advanced security",
    ],
    cta: "Contact sales",
  },
];

/** code → display name. */
export const PLAN_NAMES: Record<string, string> = Object.fromEntries(
  PLAN_CATALOG.map((p) => [p.code, p.name])
);

/** Display order of plan codes. */
export const PLAN_DISPLAY_ORDER: string[] = PLAN_CATALOG.map((p) => p.code);

/** code → { price, features } for spots that show plan copy without the API. */
export const PLAN_COPY: Record<string, { price: string; features: string[] }> =
  Object.fromEntries(
    PLAN_CATALOG.map((p) => [p.code, { price: p.price, features: p.features }])
  );

/** Friendly name for a plan code; "Free" when there is no plan. */
export const planName = (code: string | null | undefined): string =>
  code ? (PLAN_NAMES[code] ?? code) : "Free";
