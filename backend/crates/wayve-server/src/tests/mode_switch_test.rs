// Owner admin-mode switcher: proves the server-side downscope. A platform
// owner's token reaches an admin endpoint in `admin` mode (200) but is refused
// in `normal` mode (403), because the RBAC gate resolves them as a downscoped
// member. This is the core security property of the feature.
#[cfg(test)]
mod tests {
    use crate::platform_team::handler::platform_users;
    use crate::test_support::{insert_local_user, jwt_for_mode, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wayve_security::jwt::SessionMode;

    async fn make_platform_owner(pool: &PgPool, email: &str) -> i32 {
        let id = insert_local_user(pool, email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner') \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform owner: {e}"));
        id
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn admin_endpoint_allows_admin_mode_and_forbids_normal_mode() {
        let pool = test_pool().await;

        let email = random_email();
        let owner_id = make_platform_owner(&pool, &email).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(platform_users),
        )
        .await;

        // Admin mode: the owner reaches the platform-team endpoint.
        let admin_token = jwt_for_mode(owner_id, &email, SessionMode::Admin);
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/platform-team/users?account_type=personal")
                .insert_header(("Authorization", format!("Bearer {admin_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "platform owner in ADMIN mode should reach the admin endpoint"
        );

        // Normal mode: the same owner is downscoped to a member and refused.
        let normal_token = jwt_for_mode(owner_id, &email, SessionMode::Normal);
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/platform-team/users?account_type=personal")
                .insert_header(("Authorization", format!("Bearer {normal_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "platform owner in NORMAL mode must be refused (downscoped to member)"
        );
    }
}
