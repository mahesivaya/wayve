// Platform Users page endpoints: personal-scoped summary + per-user table.
// Proves (1) the platform-scope gate (401/403/200), (2) the user list is
// scoped to personal accounts (org users excluded), and (3) `storage_bytes`
// reflects the same per-user byte sum the profile endpoint uses.
#[cfg(test)]
mod tests {
    use crate::platform_team::handler::{platform_users, users_summary};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

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

    async fn make_org_owner(pool: &PgPool, email: &str) -> (i32, i32) {
        let id = insert_local_user(pool, email, "password123").await;
        let org_id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        )
        .bind(format!("Org {email}"))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert org: {e}"));
        sqlx::query(
            "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
        )
        .bind(org_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach org: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) \
             VALUES ($1, $2, 'owner') \
             ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(org_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set org role: {e}"));
        (id, org_id)
    }

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            // notes is RLS-FORCEd; delete under the bypass GUC so cleanup runs.
            if let Ok(mut tx) = pool.begin().await {
                let _ = sqlx::query("SELECT set_config('app.bypass', 'on', true)")
                    .execute(&mut *tx)
                    .await;
                let _ = sqlx::query("DELETE FROM notes WHERE user_id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await;
                let _ = tx.commit().await;
            }
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

    #[actix_web::test]
    async fn users_endpoints_require_platform_scope() {
        let pool = test_pool().await;
        let (org_id_user, org_id) = make_org_owner(&pool, &random_email()).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(users_summary)
                .service(platform_users),
        )
        .await;

        // Unauthenticated → 401.
        let req = actix_test::TestRequest::get()
            .uri("/platform-team/users")
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        // Org owner has members:read but NOT platform scope → 403.
        let org_token = jwt_for(org_id_user, "ignored@example.com");
        for uri in ["/platform-team/users-summary", "/platform-team/users"] {
            let req = actix_test::TestRequest::get()
                .uri(uri)
                .insert_header(("Authorization", format!("Bearer {org_token}")))
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::FORBIDDEN,
                "org owner should be forbidden on {uri}"
            );
        }

        cleanup(&pool, &[org_id_user], &[org_id]).await;
    }

    #[actix_web::test]
    async fn users_list_is_personal_scoped_with_storage() {
        let pool = test_pool().await;
        let owner_email = random_email();
        let owner_id = make_platform_owner(&pool, &owner_email).await;

        let personal_email = random_email();
        let personal_id = insert_local_user(&pool, &personal_email, "password123").await;
        // Personal users default to account_type='personal' on insert.

        let (org_user_id, org_id) = make_org_owner(&pool, &random_email()).await;

        // Seed exactly one note so the personal user's storage_bytes equals the
        // note body length (a fresh user has no emails/files/chat/tasks).
        let note_body = "platform-users-test-note-30byte"; // 31 bytes
        // notes is RLS-FORCEd; seed the note under the bypass GUC (test setup).
        let mut note_tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.bypass', 'on', true)")
            .execute(&mut *note_tx)
            .await
            .unwrap_or_else(|e| panic!("bypass: {e}"));
        sqlx::query("INSERT INTO notes (user_id, content) VALUES ($1, $2)")
            .bind(personal_id)
            .bind(note_body)
            .execute(&mut *note_tx)
            .await
            .unwrap_or_else(|e| panic!("insert note: {e}"));
        note_tx
            .commit()
            .await
            .unwrap_or_else(|e| panic!("commit: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(platform_users),
        )
        .await;

        let token = jwt_for(owner_id, &owner_email);
        let get = |uri: String| {
            actix_test::TestRequest::get()
                .uri(&uri)
                .insert_header(("Authorization", format!("Bearer {token}")))
                .to_request()
        };

        // Search for the personal user → exactly one row, with correct storage.
        let resp: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            get(format!("/platform-team/users?q={personal_email}")),
        )
        .await;
        let rows = resp["users"]
            .as_array()
            .unwrap_or_else(|| panic!("users array"));
        assert_eq!(rows.len(), 1, "expected one personal user match");
        assert_eq!(rows[0]["email"].as_str(), Some(personal_email.as_str()));
        assert_eq!(
            rows[0]["storage_bytes"].as_i64(),
            Some(note_body.len() as i64),
            "storage_bytes should equal the seeded note body length"
        );

        // The org user must NOT appear in the personal-scoped list.
        let org_email: String = sqlx::query("SELECT email FROM users WHERE id = $1")
            .bind(org_user_id)
            .fetch_one(&pool)
            .await
            .map(|r| r.get::<String, _>("email"))
            .unwrap_or_default();
        let resp: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            get(format!("/platform-team/users?q={org_email}")),
        )
        .await;
        assert_eq!(
            resp["users"].as_array().map(|a| a.len()),
            Some(0),
            "org user must be excluded from the personal users list"
        );

        cleanup(&pool, &[owner_id, personal_id, org_user_id], &[org_id]).await;
    }
}
