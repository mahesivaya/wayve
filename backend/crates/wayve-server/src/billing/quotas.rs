// Per-customer rate-limit tiers.
//
// The `plans` table now carries two extra columns: `rate_limit_per_min` and
// `monthly_quota`. The API-key middleware reads both per request through a
// short Moka cache (60s TTL), so the request hot path doesn't hit Postgres
// just to learn how strict to be.
//
// Enforcement rules:
//   1. The per-request rate limit is `MIN(key.rate_limit_per_min, plan.rate_limit_per_min)`
//      — a customer can issue keys with looser caps than their plan allows,
//      but the plan cap always wins.
//   2. The monthly quota counts every request across every key the user owns.
//      One key can't bypass the customer-wide quota by being spread across
//      siblings. -1 in the plan means unlimited.

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

/// Per-user resolved quota. 60s TTL is short enough that an upgrade /
/// downgrade reflects in real-world time, long enough to keep this off the
/// hot path of every request.
static EFFECTIVE_QUOTA_CACHE: Lazy<MokaCache<i32, EffectiveQuota>> = Lazy::new(|| {
    MokaCache::builder()
        .max_capacity(EFFECTIVE_QUOTA_CAPACITY)
        .time_to_live(Duration::from_secs(EFFECTIVE_QUOTA_TTL_SECS))
        .build()
});

/// The fallback every new account gets before any subscription resolves.
/// Mirrors the `basic_user` plan row in init.sql so a Redis-cold start does
/// not accidentally hand out unlimited access.
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

    // Use the existing plan-resolution helper so this matches every other
    // place that needs to know the user's plan (entitlements, the /billing
    // page, etc.). Returns (code, name).
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

/// Drop a cached tier for a user. Called whenever a subscription event
/// updates that user's effective plan (webhook handler, /billing/cancel).
#[allow(dead_code)]
pub async fn invalidate(user_id: i32) {
    EFFECTIVE_QUOTA_CACHE.invalidate(&user_id).await;
}

/// Compute the Redis key used to count this calendar month's API requests
/// for `user_id`. Calendar month is used (not rolling 30d) so customers can
/// reason about resets the same way Stripe presents their invoice cycle.
pub fn monthly_quota_key(user_id: i32) -> String {
    let now = chrono::Utc::now();
    format!("apikey_quota:{}:{}", user_id, now.format("%Y-%m"))
}

/// Convert "month" → seconds-to-live for the counter so abandoned keys
/// rotate out cleanly. We use a 32-day TTL (always longer than the
/// containing calendar month) so the next month's counter starts fresh.
pub fn monthly_quota_ttl_secs() -> u64 {
    32 * 86_400
}
