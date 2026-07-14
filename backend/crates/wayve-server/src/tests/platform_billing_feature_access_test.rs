//! The platform Billing console must honor the platform-scope `billing`
//! feature-access matrix, not just the RBAC permission. A platform owner can
//! remove a role from the Billing feature even though that role still holds
//! `billing:read`, and the console must then refuse it.
//!
//! The feature gate denies before the overview query runs, so these tests do not
//! depend on the runtime-created `employees` and `payroll_runs` tables.

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

    // Replaces the saved allowlist for the `billing` feature. An empty `roles`
    // clears it, restoring the code default.
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
        // With no saved rows the default applies: owner and billing are allowed,
        // everyone else is denied.
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

        // Narrowing the feature to owner-only excludes the billing role even
        // though it still holds billing:read. The owner is allowed regardless of
        // configuration.
        set_billing_platform_access(&pool, &["owner"]).await;
        assert!(
            is_allowed_platform(&pool, "billing", "owner")
                .await
                .unwrap_or_else(|e| panic!("{e}"))
        );
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

        // The caller clears the RBAC gate but must still be denied by the feature
        // gate, which is what proves the console consults the matrix.
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, user_id).await;
    }
}
