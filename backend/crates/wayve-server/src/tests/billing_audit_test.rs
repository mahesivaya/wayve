//! Tests that billing/financial changes leave a row in `audit_logs` — the
//! table the User Logs / Security dashboard reads. Plan changes, entitlement
//! grants and subscription cancellations are a financial + abuse signal, so
//! they must be auditable.
//!
//! Covers:
//!   * `refresh_entitlements` writes an `entitlement_grant` row when an active
//!     plan is granted.
//!   * A second refresh that changes nothing does NOT add a duplicate row
//!     (per-renewal webhooks must not spam the audit log).

#[cfg(test)]
mod tests {
    use crate::billing::entitlements::refresh_entitlements;
    use crate::billing::models::BillingOwner;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::Row;

    async fn audit_rows(pool: &sqlx::PgPool, actor: i32, action: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = $1 AND action = $2",
        )
        .bind(actor)
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("count audit rows: {e}"))
    }

    async fn cleanup(pool: &sqlx::PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM audit_logs WHERE actor_user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM entitlements WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM subscriptions WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        crate::test_support::delete_user(pool, user_id).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn entitlement_grant_is_written_to_audit_log() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;

        let plan_id: i32 = sqlx::query_scalar("SELECT id FROM plans WHERE code = 'advance_user'")
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("advance_user plan must exist (init.sql): {e}"));

        sqlx::query(
            "INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active')",
        )
        .bind(user_id)
        .bind(plan_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert subscription: {e}"));

        // First refresh: free → advance_user is a real grant, so it audits.
        refresh_entitlements(&pool, BillingOwner::User(user_id))
            .await
            .unwrap_or_else(|e| panic!("refresh_entitlements: {e}"));

        let row = sqlx::query(
            "SELECT resource_type, resource_id, metadata FROM audit_logs \
             WHERE actor_user_id = $1 AND action = 'entitlement_grant' \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&pool)
        .await
        .unwrap_or_else(|e| panic!("query audit row: {e}"))
        .unwrap_or_else(|| panic!("expected an entitlement_grant audit row for user {user_id}"));

        let resource_type: String = row.get("resource_type");
        assert_eq!(resource_type, "entitlement");
        let resource_id: Option<String> = row.try_get("resource_id").ok().flatten();
        assert_eq!(resource_id.as_deref(), Some("advance_user"));
        let metadata: serde_json::Value = row.get("metadata");
        assert_eq!(metadata["plan_code"], "advance_user");
        assert_eq!(metadata["active"], true);

        // Second refresh with nothing changed must NOT add another row — the
        // prior-state guard keeps per-renewal webhooks out of the audit log.
        refresh_entitlements(&pool, BillingOwner::User(user_id))
            .await
            .unwrap_or_else(|e| panic!("refresh_entitlements (2nd): {e}"));
        assert_eq!(
            audit_rows(&pool, user_id, "entitlement_grant").await,
            1,
            "an unchanged refresh must not write a duplicate audit row"
        );

        cleanup(&pool, user_id).await;
    }
}
