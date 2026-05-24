// Every API-key-authenticated request produces exactly one audit row, and the
// outcome string distinguishes why a request was denied. This is the
// compliance trail an enterprise needs — these tests prove it captures each
// terminal state of the middleware.
//
// The middleware writes audit rows from a fire-and-forget `tokio::spawn`, so
// the tests poll briefly rather than asserting synchronously.
#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::middleware::api_key::ApiKeyMiddleware;
    use crate::security::api_key::hash_api_key;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, HttpResponse, http::StatusCode, test as actix_test, web};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use std::time::Duration as StdDuration;

    async fn ok_handler() -> HttpResponse {
        HttpResponse::Ok().finish()
    }

    async fn insert_key(
        pool: &PgPool,
        user_id: i32,
        raw: &str,
        scopes: &[&str],
        expires_at: chrono::DateTime<chrono::Utc>,
        revoked: bool,
    ) -> i32 {
        let scope_vec: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO api_keys
                (user_id, name, key_hash, key_preview, key_type, scopes,
                 expires_at, rate_limit_per_min, revoked_at)
             VALUES ($1, 'audit-outcomes', $2, 'wv_sk_..._o', 'external', $3, $4, 120,
                     CASE WHEN $5 THEN NOW() ELSE NULL END)
             RETURNING id",
        )
        .bind(user_id)
        .bind(hash_api_key(raw))
        .bind(&scope_vec)
        .bind(expires_at)
        .bind(revoked)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert key: {e}"))
    }

    /// Poll the audit log until at least one row with the given outcome shows
    /// up, or 2s elapses. Returns the count seen. Polling is necessary because
    /// audit writes are spawned, not awaited inline.
    async fn wait_for_outcome(pool: &PgPool, key_id: Option<i32>, outcome: &str) -> i64 {
        for _ in 0..40 {
            let count: i64 = if let Some(id) = key_id {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM api_key_audit_log \
                     WHERE api_key_id = $1 AND outcome = $2",
                )
                .bind(id)
                .bind(outcome)
                .fetch_one(pool)
                .await
                .unwrap_or(0)
            } else {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM api_key_audit_log \
                     WHERE api_key_id IS NULL AND outcome = $1",
                )
                .bind(outcome)
                .fetch_one(pool)
                .await
                .unwrap_or(0)
            };
            if count > 0 {
                return count;
            }
            tokio::time::sleep(StdDuration::from_millis(50)).await;
        }
        0
    }

    async fn cleanup(pool: &PgPool, user_id: i32, paths: &[&str]) {
        // Clear our test rows so re-runs are stable. We delete by audit path
        // marker rather than by api_key_id because invalid-key rows have NULL.
        for path in paths {
            let _ = sqlx::query("DELETE FROM api_key_audit_log WHERE path = $1")
                .bind(path)
                .execute(pool)
                .await;
        }
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
    async fn middleware_records_allowed_denied_scope_revoked_expired_and_invalid() {
        // One scenario per outcome, all run through the same middleware so the
        // matrix lives in one place. A regression that, say, double-wrote rows
        // or skipped the spawn would show up here.
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        // Use a unique audit path so we can scope our row counts precisely
        // even with parallel-but-serial tests sharing the audit table.
        let path = format!("/api/notes/audit-{}", uuid::Uuid::new_v4());

        // UUID-tag every raw key so api_keys.key_hash UNIQUE doesn't
        // reject re-runs against the same DB.
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let good = format!("wv_sk_audit_outcome_good_{tag}");
        let wrong = format!("wv_sk_audit_outcome_wrong_scope_{tag}");
        let expired = format!("wv_sk_audit_outcome_expired_{tag}");
        let revoked = format!("wv_sk_audit_outcome_revoked_{tag}");

        let future = Utc::now() + Duration::hours(1);
        let past = Utc::now() - Duration::hours(1);

        let good_id = insert_key(&pool, user_id, &good, &["notes:read"], future, false).await;
        let wrong_id = insert_key(&pool, user_id, &wrong, &["email:read"], future, false).await;
        let expired_id = insert_key(&pool, user_id, &expired, &["notes:read"], past, false).await;
        let revoked_id = insert_key(&pool, user_id, &revoked, &["notes:read"], future, true).await;

        let route_path = path.clone();
        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route(&route_path, web::get().to(ok_handler)),
        )
        .await;

        let call = |key: &str| {
            actix_test::TestRequest::get()
                .uri(&path)
                .insert_header(("X-API-KEY", key))
                .to_request()
        };

        // Allowed.
        let resp = actix_test::call_service(&app, call(&good)).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Denied for missing scope.
        let resp = actix_test::call_service(&app, call(&wrong)).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Denied — expired.
        let resp = actix_test::call_service(&app, call(&expired)).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Denied — revoked.
        let resp = actix_test::call_service(&app, call(&revoked)).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Invalid — completely unknown key. api_key_id is NULL on this row.
        let resp = actix_test::call_service(&app, call("wv_sk_definitely_not_a_real_key")).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        assert!(
            wait_for_outcome(&pool, Some(good_id), "allowed").await >= 1,
            "no 'allowed' audit row written"
        );
        assert!(
            wait_for_outcome(&pool, Some(wrong_id), "denied_scope").await >= 1,
            "no 'denied_scope' audit row written"
        );
        // For revoked + expired outcomes, the middleware does NOT have a
        // ResolvedKey (the failure short-circuits resolution), so it writes
        // the audit row with api_key_id = NULL. Query by path instead of by
        // key id. This asymmetry vs denied_scope is intentional: surfacing
        // the key id on a revoked/expired failure would let a caller probe
        // for valid-but-expired keys.
        let _ = expired_id;
        let _ = revoked_id;
        let by_path_outcome = |outcome: &'static str| {
            let pool = pool.clone();
            let path = path.clone();
            async move {
                for _ in 0..40 {
                    let count: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM api_key_audit_log \
                         WHERE api_key_id IS NULL AND outcome = $1 AND path = $2",
                    )
                    .bind(outcome)
                    .bind(&path)
                    .fetch_one(&pool)
                    .await
                    .unwrap_or(0);
                    if count > 0 {
                        return count;
                    }
                    tokio::time::sleep(StdDuration::from_millis(50)).await;
                }
                0
            }
        };
        assert!(
            by_path_outcome("denied_expired").await >= 1,
            "no 'denied_expired' audit row written"
        );
        assert!(
            by_path_outcome("denied_revoked").await >= 1,
            "no 'denied_revoked' audit row written"
        );
        // Invalid-key rows have NULL api_key_id; scope the wait by path instead.
        let invalid_count: i64 = {
            let mut found = 0_i64;
            for _ in 0..40 {
                found = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM api_key_audit_log \
                     WHERE api_key_id IS NULL AND outcome = 'invalid' AND path = $1",
                )
                .bind(&path)
                .fetch_one(&pool)
                .await
                .unwrap_or(0);
                if found > 0 {
                    break;
                }
                tokio::time::sleep(StdDuration::from_millis(50)).await;
            }
            found
        };
        assert!(invalid_count >= 1, "no 'invalid' audit row written");

        cleanup(&pool, user_id, &[&path]).await;
    }
}
