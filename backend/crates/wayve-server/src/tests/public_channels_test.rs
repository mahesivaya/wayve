// Organization and platform channels are always public, and their chat uses
// standard (server-readable) encryption; personal accounts keep the choice of a
// private channel and stay end-to-end. See chat::helpers::channel_visibility_for
// and encryption_policy::chat_uses_standard_encryption.

#[cfg(test)]
mod tests {
    use crate::chat::handler::{create_channel, update_channel_visibility};
    use crate::encryption_policy::chat_uses_standard_encryption;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn org_user(pool: &PgPool) -> (i32, String) {
        let email = random_email();
        let user_id = insert_local_user(pool, &email, "password123").await;
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("Public channels {email}"))
                .fetch_one(pool)
                .await
                .unwrap_or_else(|e| panic!("insert org: {e}"));
        sqlx::query(
            "UPDATE users SET organization_id = $1, account_type = 'organization' WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("join org: {e}"));
        wayve_security::rbac::invalidate_role_context(user_id).await;
        (user_id, email)
    }

    async fn personal_user(pool: &PgPool) -> (i32, String) {
        let email = random_email();
        (insert_local_user(pool, &email, "password123").await, email)
    }

    /// Creates a channel through the API, asking for `private`, and returns the
    /// visibility the server stored.
    async fn create_private(pool: &PgPool, user_id: i32, email: &str) -> (i64, String) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_channel),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri("/chat/channels")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, email)),
            ))
            .set_json(serde_json::json!({ "name": "team", "visibility": "private" }))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let id = body["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("expected a channel id, got {body}"));
        let stored: String = sqlx::query_scalar("SELECT visibility FROM channels WHERE id = $1")
            .bind(id as i32)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read channel: {e}"));
        (id, stored)
    }

    async fn set_visibility(
        pool: &PgPool,
        user_id: i32,
        email: &str,
        channel_id: i64,
        visibility: &str,
    ) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_channel_visibility),
        )
        .await;
        let req = actix_test::TestRequest::patch()
            .uri(&format!("/chat/channels/{channel_id}/visibility"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, email)),
            ))
            .set_json(serde_json::json!({ "visibility": visibility }))
            .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn organization_channels_are_always_public() {
        let pool = test_pool().await;
        let (user_id, email) = org_user(&pool).await;

        let (channel_id, stored) = create_private(&pool, user_id, &email).await;
        assert_eq!(stored, "public", "an org channel must be created public");

        let status = set_visibility(&pool, user_id, &email, channel_id, "private").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            set_visibility(&pool, user_id, &email, channel_id, "public").await,
            StatusCode::OK
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn personal_channels_can_still_be_private() {
        let pool = test_pool().await;
        let (user_id, email) = personal_user(&pool).await;

        let (channel_id, stored) = create_private(&pool, user_id, &email).await;
        assert_eq!(stored, "private");
        assert_eq!(
            set_visibility(&pool, user_id, &email, channel_id, "public").await,
            StatusCode::OK
        );
        assert_eq!(
            set_visibility(&pool, user_id, &email, channel_id, "private").await,
            StatusCode::OK
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn organization_chat_uses_standard_encryption() {
        let pool = test_pool().await;
        let (org_id, _) = org_user(&pool).await;
        let (personal_id, _) = personal_user(&pool).await;

        assert!(chat_uses_standard_encryption(&pool, org_id).await);
        assert!(!chat_uses_standard_encryption(&pool, personal_id).await);
    }
}
