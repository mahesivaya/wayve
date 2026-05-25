//! Tests for the per-customer rate-limit + monthly-quota tier resolver.
//!
//! Covers:
//!   * Fallback to free tier for users with no active subscription.
//!   * Plan-tier lookup respects the active subscription's plan.
//!   * `monthly_quota_key` rotates on calendar-month boundary.
//!   * `monthly_quota_ttl_secs` is the documented 32-day TTL.

#[cfg(test)]
mod tests {
    use crate::billing::quotas::{
        effective_for_user, free_tier, invalidate, monthly_quota_key, monthly_quota_ttl_secs,
    };
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::Datelike;

    #[test]
    fn free_tier_matches_basic_user_plan_numbers() {
        // The fallback the middleware uses on a Redis-cold start must
        // match the basic_user plan row in init.sql. If init.sql changes
        // the basic_user numbers without updating free_tier(), users get
        // briefly under-limited at boot.
        let tier = free_tier();
        assert_eq!(tier.plan_code, "basic_user");
        assert_eq!(tier.plan_name, "Basic User");
        assert_eq!(tier.rate_limit_per_min, 60);
        assert_eq!(tier.monthly_quota, 50_000);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn no_subscription_falls_back_to_basic_user_tier() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        // Invalidate any cache state from previous tests for this id.
        invalidate(user_id).await;

        let tier = effective_for_user(&pool, user_id).await;
        assert_eq!(tier.plan_code, "basic_user");
        assert_eq!(tier.rate_limit_per_min, 60);
        assert_eq!(tier.monthly_quota, 50_000);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn active_subscription_drives_the_tier() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        invalidate(user_id).await;

        // Find advance_user's plan id.
        let plan_id: i32 = sqlx::query_scalar("SELECT id FROM plans WHERE code = 'advance_user'")
            .fetch_one(&pool)
            .await
            .expect("advance_user plan must exist (seeded by init.sql)");

        sqlx::query(
            "INSERT INTO subscriptions (user_id, plan_id, status)
             VALUES ($1, $2, 'active')",
        )
        .bind(user_id)
        .bind(plan_id)
        .execute(&pool)
        .await
        .expect("insert subscription");

        let tier = effective_for_user(&pool, user_id).await;
        assert_eq!(tier.plan_code, "advance_user");
        assert_eq!(tier.rate_limit_per_min, 300, "advance tier rate ceiling");
        assert_eq!(
            tier.monthly_quota, 500_000,
            "advance tier monthly request budget"
        );
    }

    #[test]
    fn monthly_quota_key_format_is_year_month() {
        let now = chrono::Utc::now();
        let key = monthly_quota_key(42);
        // The key is exactly `apikey_quota:{user_id}:{YYYY-MM}` — the
        // dispatcher and the dashboard both read this exact shape.
        let expected = format!("apikey_quota:42:{:04}-{:02}", now.year(), now.month());
        assert_eq!(key, expected);
    }

    #[test]
    fn monthly_quota_ttl_is_32_days() {
        // Calendar months can be 28-31 days. 32 days guarantees the
        // counter outlives its month so the next month starts fresh.
        assert_eq!(monthly_quota_ttl_secs(), 32 * 86_400);
    }
}
