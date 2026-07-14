// Per-customer rate-limit tiers, read by the API-key middleware through a short
// cache so the request hot path stays off Postgres.
//
// Two invariants: the effective rate limit is the MIN of the key's and the
// plan's, so a key can never be looser than the plan allows; and the monthly
// quota counts requests across every key the user owns, so work cannot be spread
// across sibling keys to evade it. A plan quota of -1 means unlimited.

use crate::prelude::*;
use crate::routes::user::current_plan_for_user;
use moka::future::Cache as MokaCache;
use std::time::Duration;
use tracing::warn;

#[derive(Clone, Debug)]
pub struct EffectiveQuota {
    pub plan_code: String,
    pub plan_name: String,
    pub rate_limit_per_min: i32,
    /// `-1` means unlimited.
    pub monthly_quota: i32,
}

const EFFECTIVE_QUOTA_TTL_SECS: u64 = 60;
const EFFECTIVE_QUOTA_CAPACITY: u64 = 50_000;

/// Per-user resolved quota. The TTL is a trade-off: short enough that an upgrade
/// or downgrade takes effect promptly, long enough to stay off the hot path.
static EFFECTIVE_QUOTA_CACHE: Lazy<MokaCache<i32, EffectiveQuota>> = Lazy::new(|| {
    MokaCache::builder()
        .max_capacity(EFFECTIVE_QUOTA_CAPACITY)
        .time_to_live(Duration::from_secs(EFFECTIVE_QUOTA_TTL_SECS))
        .build()
});

/// Fallback tier used before any subscription resolves. Must stay in sync with
/// the `basic_user` plan row in init.sql, and must never be unlimited: it is what
/// a cold start hands out.
pub fn free_tier() -> EffectiveQuota {
    EffectiveQuota {
        plan_code: "basic_user".to_string(),
        plan_name: "Basic User".to_string(),
        rate_limit_per_min: 60,
        monthly_quota: 50_000,
    }
}

/// Resolve the user's tier from the cache, or fetch fresh on miss.
pub async fn effective_for_user(pool: &PgPool, user_id: i32) -> EffectiveQuota {
    if let Some(q) = EFFECTIVE_QUOTA_CACHE.get(&user_id).await {
        return q;
    }

    let organization_id =
        sqlx::query_scalar::<_, Option<i32>>("SELECT organization_id FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .flatten();

    // Reuse the shared plan-resolution helper so quotas agree with entitlements
    // and the billing page.
    let resolved = current_plan_for_user(pool, user_id, organization_id)
        .await
        .ok();
    let (plan_code, plan_name) = match resolved {
        Some(p) => (p.code, p.name),
        None => {
            let tier = free_tier();
            EFFECTIVE_QUOTA_CACHE.insert(user_id, tier.clone()).await;
            return tier;
        }
    };

    let row = sqlx::query("SELECT rate_limit_per_min, monthly_quota FROM plans WHERE code = $1")
        .bind(&plan_code)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let tier = match row {
        Some(row) => EffectiveQuota {
            plan_code,
            plan_name,
            rate_limit_per_min: row.try_get("rate_limit_per_min").unwrap_or(60),
            monthly_quota: row.try_get("monthly_quota").unwrap_or(50_000),
        },
        None => {
            warn!(target: "api_key", user_id, plan_code, "plan row not found, falling back to free tier");
            free_tier()
        }
    };

    EFFECTIVE_QUOTA_CACHE.insert(user_id, tier.clone()).await;
    tier
}

/// Must be called whenever a subscription event changes a user's effective plan.
#[allow(dead_code)]
pub async fn invalidate(user_id: i32) {
    EFFECTIVE_QUOTA_CACHE.invalidate(&user_id).await;
}

/// Redis key counting this calendar month's API requests. Quotas reset on the
/// calendar month, not a rolling 30 days, to match how Stripe presents the
/// invoice cycle.
pub fn monthly_quota_key(user_id: i32) -> String {
    let now = chrono::Utc::now();
    format!("apikey_quota:{}:{}", user_id, now.format("%Y-%m"))
}

/// TTL for the monthly counter. Must exceed the longest calendar month so the
/// counter survives its own month, and stay short enough that next month starts
/// fresh.
pub fn monthly_quota_ttl_secs() -> u64 {
    32 * 86_400
}
