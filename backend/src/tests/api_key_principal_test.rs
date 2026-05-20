// The single auth chokepoint, `get_user_id_from_request`, must return the API
// key's acting user_id when the request was authenticated by the middleware —
// without a JWT being present at all. This is the contract that lets every
// existing handler keep its `get_user_id_from_request(&req)` line and still
// "just work" for service-to-service traffic.
#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::middleware::api_key::ApiKeyMiddleware;
    use crate::security::api_key::hash_api_key;
    use crate::security::jwt::get_user_id_from_request;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, HttpRequest, HttpResponse, http::StatusCode, test as actix_test, web};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;

    /// Handler under test — relies on the same chokepoint every real handler
    /// uses. If the middleware doesn't inject a principal, this 401s.
    async fn whoami(req: HttpRequest) -> HttpResponse {
        match get_user_id_from_request(&req) {
            Some(uid) => HttpResponse::Ok().json(serde_json::json!({ "user_id": uid })),
            None => HttpResponse::Unauthorized().finish(),
        }
    }

    async fn insert_key(pool: &PgPool, user_id: i32, raw: &str, scopes: &[&str]) -> i32 {
        let scope_vec: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO api_keys
                (user_id, name, key_hash, key_preview, key_type, scopes,
                 expires_at, rate_limit_per_min)
             VALUES ($1, 'principal-test', $2, 'wv_sk_..._p', 'external', $3, $4, 120)
             RETURNING id",
        )
        .bind(user_id)
        .bind(hash_api_key(raw))
        .bind(&scope_vec)
        .bind(Utc::now() + Duration::hours(1))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert key: {e}"))
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    async fn api_key_authenticates_as_acting_user_without_jwt() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        let raw = "wv_sk_principal_resolution_integration_test_key";
        insert_key(&pool, user_id, raw, &["notes:read"]).await;

        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/api/notes", web::get().to(whoami)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/api/notes")
            .insert_header(("X-API-KEY", raw))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(
            body.get("user_id").and_then(|v| v.as_i64()),
            Some(i64::from(user_id))
        );

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn missing_or_unmapped_route_still_denies_without_jwt() {
        // Belt-and-suspenders: when no API key header is present, the chokepoint
        // must fall back to JWT lookup — and with no JWT, it must return None.
        // A regression that returned a default user_id here would be catastrophic.
        let pool = test_pool().await;

        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/api/notes", web::get().to(whoami)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/api/notes")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
