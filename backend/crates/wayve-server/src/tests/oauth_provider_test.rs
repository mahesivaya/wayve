// OAuth 2.0 provider — the security-critical paths: authorization-code exchange
// (confidential client), single-use codes, client-secret verification, the
// consent decision issuing a code, and an issued access token authenticating an
// API call through the middleware, gated by its granted scopes.
#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::middleware::api_key::ApiKeyMiddleware;
    use crate::oauth_provider;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, HttpRequest, HttpResponse, http::StatusCode, test as actix_test, web};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use wayve_security::api_key::hash_api_key;

    const REDIRECT: &str = "https://client.example.com/callback";

    async fn insert_app(pool: &PgPool, user_id: i32, client_id: &str, secret: &str) -> i32 {
        let scopes = vec!["notes:read".to_string()];
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO developer_apps
                (user_id, created_by, name, client_id, client_secret_hash,
                 client_secret_preview, redirect_uris, scopes)
             VALUES ($1, $1, 'Test App', $2, $3, 'wv_cs_..._x', $4, $5)
             RETURNING id",
        )
        .bind(user_id)
        .bind(client_id)
        .bind(hash_api_key(secret))
        .bind(vec![REDIRECT.to_string()])
        .bind(&scopes)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert app: {e}"))
    }

    async fn insert_code(pool: &PgPool, app_id: i32, user_id: i32, raw_code: &str) {
        sqlx::query(
            "INSERT INTO oauth_auth_codes
                (code_hash, app_id, user_id, redirect_uri, scopes, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(hash_api_key(raw_code))
        .bind(app_id)
        .bind(user_id)
        .bind(REDIRECT)
        .bind(vec!["notes:read".to_string()])
        .bind(Utc::now() + Duration::minutes(1))
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert code: {e}"));
    }

    async fn cleanup(pool: &PgPool, user_id: i32, app_id: i32) {
        let _ = sqlx::query("DELETE FROM oauth_tokens WHERE app_id = $1")
            .bind(app_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM developer_apps WHERE id = $1")
            .bind(app_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    async fn echo_user(req: HttpRequest) -> HttpResponse {
        match wayve_security::jwt::get_user_id_from_request(&req) {
            Some(uid) => HttpResponse::Ok().json(serde_json::json!({ "user_id": uid })),
            None => HttpResponse::Unauthorized().finish(),
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn code_exchange_then_scoped_api_access() {
        let pool = test_pool().await;
        let user = insert_local_user(&pool, &random_email(), "password123").await;
        let client_id = format!("wv_app_{}", user); // unique per run
        let secret = "wv_cs_supersecretvalue0001";
        let app_id = insert_app(&pool, user, &client_id, secret).await;
        let raw_code = "wv_oac_testauthcode000000001";
        insert_code(&pool, app_id, user, raw_code).await;

        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .configure(oauth_provider::public_routes)
                .route("/api/notes", web::get().to(echo_user))
                .route("/api/emails", web::get().to(echo_user)),
        )
        .await;

        // Exchange the code (confidential client) → access + refresh token.
        let tok: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri("/oauth/token")
                .set_form(&[
                    ("grant_type", "authorization_code"),
                    ("code", raw_code),
                    ("redirect_uri", REDIRECT),
                    ("client_id", client_id.as_str()),
                    ("client_secret", secret),
                ])
                .to_request(),
        )
        .await;
        let access = tok["access_token"].as_str().unwrap_or("").to_string();
        let refresh = tok["refresh_token"].as_str().unwrap_or("").to_string();
        assert!(access.starts_with("wv_oat_"), "token resp: {tok}");
        assert!(refresh.starts_with("wv_ort_"));
        assert_eq!(tok["scope"], "notes:read");

        // The access token reaches a notes:read route...
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .insert_header(("Authorization", format!("Bearer {access}")))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // ...but NOT an email:read route (scope not granted).
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/emails")
                .insert_header(("Authorization", format!("Bearer {access}")))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // The code is single-use: a replay fails.
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/oauth/token")
                .set_form(&[
                    ("grant_type", "authorization_code"),
                    ("code", raw_code),
                    ("redirect_uri", REDIRECT),
                    ("client_id", client_id.as_str()),
                    ("client_secret", secret),
                ])
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Refresh grant rotates the access token.
        let refreshed: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri("/oauth/token")
                .set_form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh.as_str()),
                    ("client_id", client_id.as_str()),
                    ("client_secret", secret),
                ])
                .to_request(),
        )
        .await;
        assert!(
            refreshed["access_token"]
                .as_str()
                .unwrap_or("")
                .starts_with("wv_oat_")
        );

        cleanup(&pool, user, app_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn wrong_client_secret_is_rejected() {
        let pool = test_pool().await;
        let user = insert_local_user(&pool, &random_email(), "password123").await;
        let client_id = format!("wv_app_bad{}", user);
        let app_id = insert_app(&pool, user, &client_id, "wv_cs_rightsecret0002").await;
        let raw_code = "wv_oac_testauthcode000000002";
        insert_code(&pool, app_id, user, raw_code).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(oauth_provider::public_routes),
        )
        .await;

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/oauth/token")
                .set_form(&[
                    ("grant_type", "authorization_code"),
                    ("code", raw_code),
                    ("redirect_uri", REDIRECT),
                    ("client_id", client_id.as_str()),
                    ("client_secret", "wv_cs_WRONGsecret0002"),
                ])
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // And no token was issued.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_tokens WHERE app_id = $1")
            .bind(app_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(-1);
        assert_eq!(count, 0);

        cleanup(&pool, user, app_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn consent_approval_issues_a_code() {
        let pool = test_pool().await;
        let email = random_email();
        let user = insert_local_user(&pool, &email, "password123").await;
        let client_id = format!("wv_app_consent{}", user);
        let app_id = insert_app(&pool, user, &client_id, "wv_cs_consentsecret003").await;

        let request_id = format!("wv_oar_pending{}", user);
        sqlx::query(
            "INSERT INTO oauth_pending_authorizations
                (request_id, app_id, user_id, redirect_uri, scopes, state, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'xyz', $6)",
        )
        .bind(&request_id)
        .bind(app_id)
        .bind(user)
        .bind(REDIRECT)
        .bind(vec!["notes:read".to_string()])
        .bind(Utc::now() + Duration::minutes(5))
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert pending: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(oauth_provider::consent_decision),
        )
        .await;

        let out: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/oauth/consent/{request_id}"))
                .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, &email))))
                .set_json(serde_json::json!({ "approve": true }))
                .to_request(),
        )
        .await;
        let redirect = out["redirect_to"].as_str().unwrap_or("");
        assert!(redirect.starts_with(REDIRECT), "redirect: {out}");
        assert!(redirect.contains("code="));
        assert!(redirect.contains("state=xyz"));

        let codes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM oauth_auth_codes WHERE app_id = $1")
                .bind(app_id)
                .fetch_one(&pool)
                .await
                .unwrap_or(-1);
        assert_eq!(codes, 1);

        let _ = sqlx::query("DELETE FROM oauth_auth_codes WHERE app_id = $1")
            .bind(app_id)
            .execute(&pool)
            .await;
        cleanup(&pool, user, app_id).await;
    }
}
