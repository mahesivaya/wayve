// GET /api/integrations/status — the aggregate the sidebar's Integrations group
// reads. It must report only what is genuinely connected AND enabled: a stored
// but disabled connection is set up, not live, and listing it would tell the
// user a service is working when it isn't.
#[cfg(test)]
mod tests {
    use crate::integrations;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, test as actix_test, web};
    use sqlx::PgPool;

    async fn cleanup(pool: &PgPool, user_id: i32) {
        // github_accounts / user_gitlab_connections cascade from users.
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    fn connected(body: &serde_json::Value) -> Vec<String> {
        body["connected"]
            .as_array()
            .unwrap_or_else(|| panic!("connected array, got {body}"))
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reports_only_connected_and_enabled_services() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::status::get_status),
        )
        .await;

        // Same authenticated GET, asked after each change to the fixtures.
        macro_rules! status {
            () => {{
                let req = actix_test::TestRequest::get()
                    .uri("/integrations/status")
                    .insert_header(("Authorization", bearer.clone()))
                    .to_request();
                let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
                connected(&body)
            }};
        }

        // A fresh account has connected nothing.
        assert!(status!().is_empty());

        // GitHub has no enabled flag — the row IS the connection.
        sqlx::query(
            "INSERT INTO github_accounts
                (user_id, github_login, access_token_iv, access_token_encrypted)
             VALUES ($1, 'octocat', 'iv', 'enc')",
        )
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert github_accounts: {e}"));

        assert_eq!(status!(), vec!["github".to_string()]);

        // A disabled GitLab connection exists but isn't live, so it must not
        // show up alongside GitHub.
        sqlx::query(
            "INSERT INTO user_gitlab_connections
                (user_id, base_url, access_token_iv, access_token_encrypted, enabled)
             VALUES ($1, 'https://gitlab.com', 'iv', 'enc', FALSE)",
        )
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert user_gitlab_connections: {e}"));

        assert_eq!(status!(), vec!["github".to_string()]);

        // Enabling it puts it on the list.
        sqlx::query("UPDATE user_gitlab_connections SET enabled = TRUE WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("enable gitlab: {e}"));

        let mut live = status!();
        live.sort();
        assert_eq!(live, vec!["github".to_string(), "gitlab".to_string()]);

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn requires_authentication() {
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::status::get_status),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/integrations/status")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), actix_web::http::StatusCode::UNAUTHORIZED);
    }
}
