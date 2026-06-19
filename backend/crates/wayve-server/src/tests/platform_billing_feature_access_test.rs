//! The platform Billing console (`/platform-billing/*`) must honor the
//! `billing` feature-access matrix at the platform scope — not just the RBAC
//! permission. A platform owner can remove a role from the Billing feature even
//! if that role holds `billing:read`, and the gate must then return 403.
//!
//! Covers:
//!   * `is_allowed_platform` for the `billing` feature: defaults (owner + billing
//!     allowed, others denied), a saved config that narrows it, and the
//!     always-allowed owner.
//!   * The wiring: `GET /platform-billing/overview` returns 403 for a `billing`-
//!     role user (who passes the RBAC gate) once the platform owner restricts the
//!     Billing feature to owner-only. The gate denies before the overview query,
//!     so this does not depend on the runtime-created `employees`/`payroll_runs`
//!     tables.

#[cfg(test)]
mod tests {
    use crate::feature_access::handler::is_allowed_platform;
    use crate::platform_billing::handler::get_overview;
    use crate::test_support::{delete_user, insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn make_platform_member(pool: &PgPool, user_id: i32, role: &str) {
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform account_type: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, $2) \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform role: {e}"));
    }

    // Replace the saved platform allowlist for the `billing` feature with exactly
    // `roles` (empty `roles` clears it, restoring the code default).
    async fn set_billing_platform_access(pool: &PgPool, roles: &[&str]) {
        sqlx::query("DELETE FROM platform_feature_access WHERE feature_key = 'billing'")
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("clear billing platform access: {e}"));
        for role in roles {
            sqlx::query(
                "INSERT INTO platform_feature_access (feature_key, role) VALUES ('billing', $1)",
            )
            .bind(role)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("insert billing platform access: {e}"));
        }
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM platform_feature_access WHERE feature_key = 'billing'")
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        delete_user(pool, user_id).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn is_allowed_platform_honors_billing_defaults_and_config() {
        let pool = test_pool().await;
        // Default (no saved rows): owner + billing allowed; others denied.
        set_billing_platform_access(&pool, &[]).await;
        assert!(
            is_allowed_platform(&pool, "billing", "owner")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );
        assert!(
            is_allowed_platform(&pool, "billing", "billing")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );
        assert!(
            !is_allowed_platform(&pool, "billing", "support")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );

        // Owner narrows the feature to owner-only.
        set_billing_platform_access(&pool, &["owner"]).await;
        // Owner is always allowed regardless of configuration.
        assert!(
            is_allowed_platform(&pool, "billing", "owner")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );
        // The billing role is now excluded even though it holds billing:read.
        assert!(
            !is_allowed_platform(&pool, "billing", "billing")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );

        let _ = sqlx::query("DELETE FROM platform_feature_access WHERE feature_key = 'billing'")
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn platform_billing_overview_403_when_billing_feature_restricted() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        make_platform_member(&pool, user_id, "billing").await;

        // Owner restricts the Billing feature to owner-only at the platform scope.
        set_billing_platform_access(&pool, &["owner"]).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_overview),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/platform-billing/overview")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        // RBAC passes (billing role holds billing:read) but the feature gate
        // denies — proving the platform billing console enforces the matrix.
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, user_id).await;
    }
}
