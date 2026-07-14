// RBAC gates on the shared Documents workspace. Mutating a document requires
// `documents:manage`, held only by owner and super_admin; every other member is
// read-only. These drive the real handlers through an actix test service, so a
// refactor that drops the gate and lets an ordinary member mutate the workspace
// fails here.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

    /// Document blobs are encrypted at rest, so the handlers need `AES_KEY`. CI
    /// sets it globally; this fallback keeps the tests self-sufficient locally.
    fn ensure_aes_key() {
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

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

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        // org_documents / org_document_folders FK-cascade on organization delete.
        for id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    fn bearer(user_id: i32, email: &str) -> (String, String) {
        (
            "Authorization".to_string(),
            format!("Bearer {}", jwt_for(user_id, email)),
        )
    }

    async fn org_with_owner_and_member(pool: &PgPool) -> (i32, i32, String, i32, String) {
        let org_id = insert_org(pool, &format!("Docs RBAC {}", random_email())).await;

        let owner_email = random_email();
        let owner_id = insert_local_user(pool, &owner_email, "password123").await;
        place_in_org(pool, owner_id, org_id, "owner").await;

        let member_email = random_email();
        let member_id = insert_local_user(pool, &member_email, "password123").await;
        place_in_org(pool, member_id, org_id, "member").await;

        (org_id, owner_id, owner_email, member_id, member_email)
    }

    fn create_doc_req(user_id: i32, email: &str, name: &str) -> actix_test::TestRequest {
        actix_test::TestRequest::post()
            .uri("/documents/new")
            .insert_header(bearer(user_id, email))
            .set_json(serde_json::json!({ "name": name, "content": "hello world" }))
    }

    #[actix_web::test]
    async fn owner_can_create_document_but_member_cannot() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (org_id, owner_id, owner_email, member_id, member_email) =
            org_with_owner_and_member(&pool).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::documents::routes),
        )
        .await;

        let resp = actix_test::call_service(
            &app,
            create_doc_req(owner_id, &owner_email, "owner-note.md").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["name"], "owner-note.md");
        assert!(body["id"].as_i64().is_some());

        let resp = actix_test::call_service(
            &app,
            create_doc_req(member_id, &member_email, "member-note.md").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn member_can_list_documents() {
        // The manage gate must not cost a plain member their read access.
        ensure_aes_key();
        let pool = test_pool().await;
        let (org_id, owner_id, owner_email, member_id, member_email) =
            org_with_owner_and_member(&pool).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::documents::routes),
        )
        .await;

        let resp = actix_test::call_service(
            &app,
            create_doc_req(owner_id, &owner_email, "shared.md").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        let req = actix_test::TestRequest::get()
            .uri("/documents")
            .insert_header(bearer(member_id, &member_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let names: Vec<&str> = body
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|d| d["name"].as_str())
            .collect();
        assert!(
            names.contains(&"shared.md"),
            "member should see the doc: {names:?}"
        );

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn member_cannot_edit_delete_but_owner_can() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (org_id, owner_id, owner_email, member_id, member_email) =
            org_with_owner_and_member(&pool).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::documents::routes),
        )
        .await;

        let resp = actix_test::call_service(
            &app,
            create_doc_req(owner_id, &owner_email, "editable.md").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let doc_id = body["id"].as_i64().expect("doc id");

        let req = actix_test::TestRequest::put()
            .uri(&format!("/documents/{doc_id}/content"))
            .insert_header(bearer(member_id, &member_email))
            .set_json(serde_json::json!({ "content": "tampered" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let req = actix_test::TestRequest::delete()
            .uri(&format!("/documents/{doc_id}"))
            .insert_header(bearer(member_id, &member_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // The refused delete must not have removed the row.
        let still_there: i64 =
            sqlx::query("SELECT id FROM org_documents WHERE id = $1 AND organization_id = $2")
                .bind(doc_id)
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map(|r| r.get::<i64, _>("id"))
                .unwrap_or_else(|e| panic!("doc should still exist: {e}"));
        assert_eq!(still_there, doc_id);

        let req = actix_test::TestRequest::put()
            .uri(&format!("/documents/{doc_id}/content"))
            .insert_header(bearer(owner_id, &owner_email))
            .set_json(serde_json::json!({ "content": "owner edit" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let req = actix_test::TestRequest::delete()
            .uri(&format!("/documents/{doc_id}"))
            .insert_header(bearer(owner_id, &owner_email))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }
}
