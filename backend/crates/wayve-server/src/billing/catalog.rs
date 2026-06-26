//! Single source of truth for the plan catalog.
//!
//! **Edit THIS file to change pricing/plans.** Nothing else hardcodes the plan
//! rows:
//!   * `startup::seed_plan_catalog` upserts these into the `plans` table on
//!     every boot (fresh & existing DBs converge — no migration needed), and
//!   * `billing::entitlements` reads the free tier here for the
//!     no-subscription baseline.
//!
//! The frontend mirrors this list in `frontend/src/billing/planCatalog.ts`
//! (display copy + marketing prices). Keep the two in sync when adding/removing
//! a plan or changing limits.

/// One plan in the catalog. Mirrors the `plans` table columns the seed writes.
/// `storage_limit_bytes` / `monthly_quota` use `-1` for "unlimited".
pub struct PlanDef {
    pub code: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// "personal" | "organization"
    pub audience: &'static str,
    /// "personal" | "startups" | "business" | "enterprise"
    pub tier: &'static str,
    pub amount_cents: i64,
    pub storage_limit_bytes: i64,
    pub seat_limit: i32,
    pub rate_limit_per_min: i32,
    pub monthly_quota: i32,
    /// Display bullets, stored as `features.bullets` JSON.
    pub features: &'static [&'static str],
}

/// The canonical plan lineup. Order here is the display order.
pub const PLAN_CATALOG: &[PlanDef] = &[
    PlanDef {
        code: "basic_user",
        name: "Free Personal",
        description: "Free plan for individual accounts.",
        audience: "personal",
        tier: "personal",
        amount_cents: 0,
        storage_limit_bytes: 1_073_741_824, // 1 GiB
        seat_limit: 1,
        rate_limit_per_min: 60,
        monthly_quota: 50_000,
        features: &[
            "1 GB encrypted storage",
            "Up to 1,000 emails per day",
            "End-to-end encrypted chat",
            "1 seat",
        ],
    },
    PlanDef {
        code: "advance_user",
        name: "Advanced Personal",
        description: "Paid personal plan with higher limits.",
        audience: "personal",
        tier: "personal",
        amount_cents: 700,
        storage_limit_bytes: 10_737_418_240, // 10 GiB
        seat_limit: 1,
        rate_limit_per_min: 300,
        monthly_quota: 500_000,
        features: &[
            "10 GB encrypted storage",
            "Unlimited daily emails",
            "1,000 encrypt/decrypt ops per day",
            "Priority email sync",
        ],
    },
    PlanDef {
        code: "business_startups",
        name: "Free Organization",
        description: "Free plan for small teams to evaluate org features.",
        audience: "organization",
        tier: "startups",
        amount_cents: 0,
        storage_limit_bytes: 5_368_709_120, // 5 GiB
        seat_limit: 5,
        rate_limit_per_min: 120,
        monthly_quota: 100_000,
        features: &[
            "Up to 5 members",
            "5 GB shared storage",
            "Shared org workspace",
            "Admin & billing controls",
        ],
    },
    PlanDef {
        code: "organization",
        name: "Advanced Organization",
        description: "For growing organizations up to 100 members.",
        audience: "organization",
        tier: "business",
        amount_cents: 1200,
        storage_limit_bytes: -1, // unlimited
        seat_limit: 100,
        rate_limit_per_min: 1200,
        monthly_quota: 10_000_000,
        features: &[
            "Up to 100 members",
            "Unlimited storage & email",
            "SSO + role-based access",
            "Audit logs & priority support",
        ],
    },
    PlanDef {
        code: "enterprise",
        name: "Enterprise",
        description: "100+ members with unlimited everything.",
        audience: "organization",
        tier: "enterprise",
        amount_cents: 4900,
        storage_limit_bytes: -1, // unlimited
        seat_limit: 100_000,
        rate_limit_per_min: 6000,
        monthly_quota: -1, // unlimited
        features: &[
            "Unlimited members",
            "Dedicated success manager",
            "Custom onboarding & SLA",
            "SSO, SCIM & advanced security",
        ],
    },
];

/// The free (no-subscription) baseline plan for an audience — the $0 plan whose
/// `audience` matches. Used by `entitlements` when an owner has no active
/// subscription (personal → Free Personal, organization → Free Organization).
/// Falls back to the first catalog entry (Free Personal) for any other input.
pub fn free_plan_for(audience: &str) -> &'static PlanDef {
    PLAN_CATALOG
        .iter()
        .find(|p| p.audience == audience && p.amount_cents == 0)
        .unwrap_or(&PLAN_CATALOG[0])
}
