// End-to-end tests for the key-management HTTP surface in `routes/api_keys.rs`.
// These cover what humans hit through the admin UI — minting a key, listing
// keys (scoped to the caller), revoking a key, and reading its audit page —
// rather than the runtime middleware path (covered separately).
#[cfg(test)]
mod tests {
    use crate::routes::api_keys::{
        api_key_audit, create_api_key, list_api_keys, revoke_api_key,
    };
    use crate::security::api_key::{AuditEntry, AuditOutcome, hash_api_key, write_audit};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn place_in_org(pool: &PgPool, user_id: i32, org_id: i32, role: &str) {
        sqlx::query(
            "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach user: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (organization_id, user_id) DO UPDATE \
             SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set role: {e}"));
    }

    async fn make_platform_owner(pool: &PgPool, user_id: i32) {
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner') \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1 OR created_by = $1")
                .bind(id)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    fn bearer(uid: i32, email: &str) -> (&'static str, String) {
        ("Authorization", format!("Bearer {}", jwt_for(uid, email)))
    }

    #[actix_web::test]
    async fn personal_user_can_mint_and_use_external_key() {
        // A personal account is an Owner of a workspace of one — so it holds
        // api_keys:manage and may create a properly-formed external key.
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_api_key),
        )
        .await;

        let expires_at = Utc::now() + Duration::days(7);
        let req = actix_test::TestRequest::post()
            .uri("/keys")
            .insert_header(bearer(user_id, &email))
            .set_json(serde_json::json!({
                "name": "ci-key",
                "key_type": "external",
                "scopes": ["notes:read", "notes:write"],
                "expires_at": expires_at,
            }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let raw = body.get("api_key").and_then(|v| v.as_str()).unwrap();
        assert!(
            raw.starts_with("wv_sk_"),
            "raw key must use the wv_sk_ prefix"
        );
        assert_eq!(raw.len(), "wv_sk_".len() + 48);
        // Preview is redacted; the raw value is shown exactly once.
        assert!(body.get("key_preview").is_some());

        // Only the hash, never the raw key, ends up in the DB.
        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM api_keys WHERE key_hash = $1 AND user_id = $2",
        )
        .bind(hash_api_key(raw))
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, 1);
        let raw_match: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE key_hash = $1")
            .bind(raw)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(raw_match, 0, "raw key must not be stored verbatim");

        cleanup(&pool, &[user_id], &[]).await;
    }

    #[actix_web::test]
    async fn external_key_must_have_scopes_and_future_expiry() {
        // The "external" key contract: explicit scopes, no `*`, mandatory
        // future expiry. Each branch is a 400 — never a soft default.
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_api_key),
        )
        .await;

        let future = Utc::now() + Duration::days(1);
        let past = Utc::now() - Duration::minutes(1);

        let cases = [
            (
                "no scopes",
                serde_json::json!({
                    "name": "k", "key_type": "external", "scopes": [], "expires_at": future
                }),
            ),
            (
                "wildcard rejected on external",
                serde_json::json!({
                    "name": "k", "key_type": "external", "scopes": ["*"], "expires_at": future
                }),
            ),
            (
                "no expiry",
                serde_json::json!({
                    "name": "k", "key_type": "external", "scopes": ["notes:read"]
                }),
            ),
            (
                "expiry in the past",
                serde_json::json!({
                    "name": "k", "key_type": "external", "scopes": ["notes:read"], "expires_at": past
                }),
            ),
            (
                "unknown scope",
                serde_json::json!({
                    "name": "k", "key_type": "external", "scopes": ["notes:destroy"], "expires_at": future
                }),
            ),
        ];

        for (label, body) in cases {
            let req = actix_test::TestRequest::post()
                .uri("/keys")
                .insert_header(bearer(user_id, &email))
                .set_json(body)
                .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "expected 400 for {label}"
            );
        }

        cleanup(&pool, &[user_id], &[]).await;
    }

    #[actix_web::test]
    async fn only_platform_staff_can_mint_internal_keys() {
        // `internal` keys may hold `*`, so they are platform-only. A personal
        // owner has every permission — but not the right *scope*.
        let pool = test_pool().await;
        let personal_email = random_email();
        let personal_id = insert_local_user(&pool, &personal_email, "password123").await;
        let platform_email = random_email();
        let platform_id = insert_local_user(&pool, &platform_email, "password123").await;
        make_platform_owner(&pool, platform_id).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_api_key),
        )
        .await;

        let body = serde_json::json!({
            "name": "svc",
            "key_type": "internal",
            "scopes": ["*"],
        });

        let req = actix_test::TestRequest::post()
            .uri("/keys")
            .insert_header(bearer(personal_id, &personal_email))
            .set_json(&body)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "personal owner must not mint internal keys"
        );

        let req = actix_test::TestRequest::post()
            .uri("/keys")
            .insert_header(bearer(platform_id, &platform_email))
            .set_json(&body)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        cleanup(&pool, &[personal_id, platform_id], &[]).await;
    }

    #[actix_web::test]
    async fn key_listing_does_not_cross_organization_boundary() {
        // An org admin in tenant A must not see keys minted in tenant B. The
        // SQL filter in `list_api_keys` is the only thing preventing tenant
        // disclosure on this endpoint, so we exercise it directly.
        let pool = test_pool().await;
        let org_a = insert_org(&pool, &format!("Keys A {}", random_email())).await;
        let org_b = insert_org(&pool, &format!("Keys B {}", random_email())).await;

        let admin_a_email = random_email();
        let admin_a_id = insert_local_user(&pool, &admin_a_email, "password123").await;
        place_in_org(&pool, admin_a_id, org_a, "owner").await;

        let user_b_id = insert_local_user(&pool, &random_email(), "password123").await;
        place_in_org(&pool, user_b_id, org_b, "owner").await;

        // Mint one key per tenant.
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_api_key)
                .service(list_api_keys),
        )
        .await;

        let future = Utc::now() + Duration::days(7);
        for (uid, email) in [(admin_a_id, &admin_a_email)] {
            let req = actix_test::TestRequest::post()
                .uri("/keys")
                .insert_header(bearer(uid, email))
                .set_json(serde_json::json!({
                    "name": "tenant-a-key",
                    "key_type": "external",
                    "scopes": ["notes:read"],
                    "expires_at": future,
                }))
                .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::CREATED);
        }

        // Insert a tenant-B key directly, owned by user_b.
        sqlx::query(
            "INSERT INTO api_keys (organization_id, user_id, created_by, name, key_hash, key_preview, key_type, scopes, expires_at, rate_limit_per_min) \
             VALUES ($1, $2, $2, 'tenant-b-key', $3, 'wv_sk_..._b', 'external', $4, $5, 120)",
        )
        .bind(org_b)
        .bind(user_b_id)
        .bind(hash_api_key("wv_sk_seed_only_tenant_b_key_value_for_test"))
        .bind(vec!["notes:read".to_string()])
        .bind(future)
        .execute(&pool)
        .await
        .unwrap();

        // Admin A lists: only their own tenant's keys are visible.
        let req = actix_test::TestRequest::get()
            .uri("/keys")
            .insert_header(bearer(admin_a_id, &admin_a_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let names: Vec<&str> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.get("name").and_then(|n| n.as_str()).unwrap_or(""))
            .collect();
        assert!(names.contains(&"tenant-a-key"));
        assert!(
            !names.contains(&"tenant-b-key"),
            "tenant B key must not leak into tenant A listing: {names:?}"
        );

        cleanup(&pool, &[admin_a_id, user_b_id], &[org_a, org_b]).await;
    }

    #[actix_web::test]
    async fn revoke_marks_key_revoked_and_404s_on_second_call() {
        // Revoking is the safety brake when a key is lost. It must be
        // idempotent (one revoke wins, repeats 404) and ownership-checked
        // (a stranger can't revoke a key they don't own).
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;

        let key_id: i32 = sqlx::query_scalar(
            "INSERT INTO api_keys (user_id, created_by, name, key_hash, key_preview, key_type, scopes, expires_at, rate_limit_per_min) \
             VALUES ($1, $1, 'revoke-me', $2, 'wv_sk_..._r', 'external', $3, $4, 120) \
             RETURNING id",
        )
        .bind(user_id)
        .bind(hash_api_key("wv_sk_revoke_target_for_integration_test"))
        .bind(vec!["notes:read".to_string()])
        .bind(Utc::now() + Duration::days(1))
        .fetch_one(&pool)
        .await
        .unwrap();

        // A stranger may not revoke this key.
        let stranger_email = random_email();
        let stranger_id = insert_local_user(&pool, &stranger_email, "password123").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(revoke_api_key),
        )
        .await;

        let req = actix_test::TestRequest::delete()
            .uri(&format!("/keys/{key_id}"))
            .insert_header(bearer(stranger_id, &stranger_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "stranger sees the key as nonexistent"
        );

        // Owner revoke: 200, revoked_at populated.
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/keys/{key_id}"))
            .insert_header(bearer(user_id, &email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let revoked_at: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar("SELECT revoked_at FROM api_keys WHERE id = $1")
                .bind(key_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(revoked_at.is_some(), "revoked_at must be stamped");

        // Second revoke is a 404 (idempotent — already revoked).
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/keys/{key_id}"))
            .insert_header(bearer(user_id, &email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[user_id, stranger_id], &[]).await;
    }

    #[actix_web::test]
    async fn audit_endpoint_returns_rows_for_key_owner_only() {
        // The audit endpoint is what an org admin uses during incident
        // response — it must (a) return the key's rows in newest-first order
        // and (b) refuse to disclose anything to a non-owner.
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;

        let key_id: i32 = sqlx::query_scalar(
            "INSERT INTO api_keys (user_id, created_by, name, key_hash, key_preview, key_type, scopes, expires_at, rate_limit_per_min) \
             VALUES ($1, $1, 'audit-me', $2, 'wv_sk_..._a', 'external', $3, $4, 120) \
             RETURNING id",
        )
        .bind(user_id)
        .bind(hash_api_key("wv_sk_audit_endpoint_target_test_key_value"))
        .bind(vec!["notes:read".to_string()])
        .bind(Utc::now() + Duration::days(1))
        .fetch_one(&pool)
        .await
        .unwrap();

        // Seed a couple of audit rows synchronously so the endpoint has data.
        for (outcome, status) in [
            (AuditOutcome::Allowed, 200_i32),
            (AuditOutcome::DeniedScope, 403_i32),
        ] {
            write_audit(
                &pool,
                &AuditEntry {
                    api_key_id: Some(key_id),
                    user_id: Some(user_id),
                    method: "GET".to_string(),
                    path: "/api/notes".to_string(),
                    status_code: status,
                    outcome,
                    ip: Some("127.0.0.1".to_string()),
                },
            )
            .await;
        }

        let stranger_email = random_email();
        let stranger_id = insert_local_user(&pool, &stranger_email, "password123").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(api_key_audit),
        )
        .await;

        // Owner sees the rows.
        let req = actix_test::TestRequest::get()
            .uri(&format!("/keys/{key_id}/audit"))
            .insert_header(bearer(user_id, &email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let rows = body.as_array().expect("array");
        assert!(rows.len() >= 2, "expected at least 2 audit rows");
        let outcomes: Vec<&str> = rows
            .iter()
            .map(|r| r.get("outcome").and_then(|o| o.as_str()).unwrap_or(""))
            .collect();
        assert!(outcomes.contains(&"allowed"));
        assert!(outcomes.contains(&"denied_scope"));

        // Stranger sees a 404 — not even confirmation the key exists.
        let req = actix_test::TestRequest::get()
            .uri(&format!("/keys/{key_id}/audit"))
            .insert_header(bearer(stranger_id, &stranger_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[user_id, stranger_id], &[]).await;
    }
}
