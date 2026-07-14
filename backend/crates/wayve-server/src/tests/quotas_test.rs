//! The per-customer rate-limit and monthly-quota tier resolver: which tier a
//! user gets with and without an active subscription, and the exact shape and
//! lifetime of the monthly counter key.

#[cfg(test)]
mod tests {
    use crate::billing::quotas::{
        effective_for_user, free_tier, invalidate, monthly_quota_key, monthly_quota_ttl_secs,
    };
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::Datelike;

    #[test]
    fn free_tier_matches_basic_user_plan_numbers() {
        // The middleware falls back to these numbers on a Redis-cold start, so
        // they must match the basic_user plan row in init.sql. If init.sql moves
        // and free_tier() does not, users are under-limited at boot.
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
        // The tier is cached, so any state left by an earlier test must go.
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
        // The dispatcher and the dashboard both read this exact key shape.
        let expected = format!("apikey_quota:42:{:04}-{:02}", now.year(), now.month());
        assert_eq!(key, expected);
    }

    #[test]
    fn monthly_quota_ttl_is_32_days() {
        // A calendar month runs 28 to 31 days, so a 32-day TTL guarantees the
        // counter outlives its month and the next one starts fresh.
        assert_eq!(monthly_quota_ttl_secs(), 32 * 86_400);
    }
}
