// Developer-app registration endpoints. Proves: an owner (holds api_keys:manage)
// can register an app and gets the client secret exactly once; the secret is
// never returned by list; rotate/patch/revoke work; scope validation rejects '*'
// and bad redirect URIs; and apps are isolated across orgs.
#[cfg(test)]
mod tests {
    use crate::routes::developer_apps;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn place_owner(pool: &PgPool, user_id: i32, org_id: i32) {
        sqlx::query(
            "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach user: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set owner: {e}"));
    }

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
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

    fn service() -> App<
        impl actix_web::dev::ServiceFactory<
            actix_web::dev::ServiceRequest,
            Config = (),
            Response = actix_web::dev::ServiceResponse,
            Error = actix_web::Error,
            InitError = (),
        >,
    > {
        App::new().configure(developer_apps::routes)
    }

    #[actix_web::test]
    async fn owner_registers_app_and_manages_it() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("Dev Org {}", random_email())).await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        place_owner(&pool, owner, org_id).await;

        let app = actix_test::init_service(service().app_data(web::Data::new(pool.clone()))).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));

        // Create → secret returned exactly once.
        let created: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri("/developer/apps")
                .insert_header(("Authorization", bearer.clone()))
                .set_json(serde_json::json!({
                    "name": "My Integration",
                    "homepage_url": "https://app.example.com",
                    "redirect_uris": ["https://app.example.com/callback"],
                    "scopes": ["notes:read", "chat:write"]
                }))
                .to_request(),
        )
        .await;
        let app_id = created["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("id: {created}"));
        assert!(
            created["client_id"]
                .as_str()
                .unwrap_or("")
                .starts_with("wv_app_")
        );
        let first_secret = created["client_secret"].as_str().unwrap_or("");
        assert!(first_secret.starts_with("wv_cs_"), "secret: {created}");
        assert!(
            created["client_secret_preview"]
                .as_str()
                .unwrap_or("")
                .contains("...")
        );

        // List → app present, secret NEVER exposed (only its preview).
        let list: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::get()
                .uri("/developer/apps")
                .insert_header(("Authorization", bearer.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(list.as_array().map(|a| a.len()), Some(1));
        assert!(
            list[0].get("client_secret").is_none(),
            "secret leaked in list"
        );
        assert!(
            list[0]["client_secret_preview"]
                .as_str()
                .unwrap_or("")
                .contains("...")
        );

        // Rotate → a different secret, shown once.
        let rotated: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/developer/apps/{app_id}/rotate-secret"))
                .insert_header(("Authorization", bearer.clone()))
                .to_request(),
        )
        .await;
        let new_secret = rotated["client_secret"].as_str().unwrap_or("");
        assert!(new_secret.starts_with("wv_cs_") && new_secret != first_secret);

        // Patch → rename + narrow scopes.
        let patched: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::patch()
                .uri(&format!("/developer/apps/{app_id}"))
                .insert_header(("Authorization", bearer.clone()))
                .set_json(serde_json::json!({ "name": "Renamed", "scopes": ["notes:read"] }))
                .to_request(),
        )
        .await;
        assert_eq!(patched["name"], "Renamed");
        assert_eq!(patched["scopes"].as_array().map(|a| a.len()), Some(1));

        // Validation: '*' scope and a non-http(s) redirect are rejected.
        for body in [
            serde_json::json!({ "name": "X", "scopes": ["*"] }),
            serde_json::json!({ "name": "X", "redirect_uris": ["ftp://x/cb"] }),
        ] {
            let resp = actix_test::call_service(
                &app,
                actix_test::TestRequest::post()
                    .uri("/developer/apps")
                    .insert_header(("Authorization", bearer.clone()))
                    .set_json(body)
                    .to_request(),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }

        // Revoke (soft) → revoked_at set, still listed.
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::delete()
                .uri(&format!("/developer/apps/{app_id}"))
                .insert_header(("Authorization", bearer.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let list: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::get()
                .uri("/developer/apps")
                .insert_header(("Authorization", bearer))
                .to_request(),
        )
        .await;
        assert!(!list[0]["revoked_at"].is_null(), "app should be revoked");

        cleanup(&pool, &[owner], &[org_id]).await;
    }

    #[actix_web::test]
    async fn apps_are_isolated_across_orgs() {
        let pool = test_pool().await;
        let org_a = insert_org(&pool, &format!("A {}", random_email())).await;
        let org_b = insert_org(&pool, &format!("B {}", random_email())).await;
        let email_a = random_email();
        let email_b = random_email();
        let owner_a = insert_local_user(&pool, &email_a, "password123").await;
        let owner_b = insert_local_user(&pool, &email_b, "password123").await;
        place_owner(&pool, owner_a, org_a).await;
        place_owner(&pool, owner_b, org_b).await;

        let app = actix_test::init_service(service().app_data(web::Data::new(pool.clone()))).await;

        // A registers an app.
        let created: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri("/developer/apps")
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(owner_a, &email_a)),
                ))
                .set_json(serde_json::json!({ "name": "A App", "scopes": ["notes:read"] }))
                .to_request(),
        )
        .await;
        let a_app_id = created["id"].as_i64().unwrap_or_default();

        // B cannot see it, and cannot rotate/delete it (404, not 403 — no leak).
        let b_bearer = format!("Bearer {}", jwt_for(owner_b, &email_b));
        let b_list: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::get()
                .uri("/developer/apps")
                .insert_header(("Authorization", b_bearer.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(b_list.as_array().map(|a| a.len()), Some(0));

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/developer/apps/{a_app_id}/rotate-secret"))
                .insert_header(("Authorization", b_bearer.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::delete()
                .uri(&format!("/developer/apps/{a_app_id}"))
                .insert_header(("Authorization", b_bearer))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[owner_a, owner_b], &[org_a, org_b]).await;
    }
}
