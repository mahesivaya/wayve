// Workspace projects + teams endpoints. Proves the product rule "only an
// organization owner can create projects and teams": an owner gets 201, a
// plain member gets 403, and listing is org-scoped (members see their org's
// items, a personal account sees an empty list).
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::workspace;
    use actix_web::{App, http::StatusCode, test as actix_test, web};
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

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        // projects/teams cascade from organizations on delete.
        for id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    async fn owner_creates_member_lists_nonowner_blocked() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("WS Org {}", random_email())).await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;

        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "password123").await;
        place_in_org(&pool, member_id, org_id, "member").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(workspace::handler::create_project)
                .service(workspace::handler::list_projects)
                .service(workspace::handler::create_team)
                .service(workspace::handler::list_teams),
        )
        .await;

        let bearer = |uid: i32, email: &str| format!("Bearer {}", jwt_for(uid, email));

        // Owner creates a project → 201.
        let req = actix_test::TestRequest::post()
            .uri("/projects")
            .insert_header(("Authorization", bearer(owner_id, &owner_email)))
            .set_json(serde_json::json!({ "name": "Apollo" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Owner creates a team → 201.
        let req = actix_test::TestRequest::post()
            .uri("/teams")
            .insert_header(("Authorization", bearer(owner_id, &owner_email)))
            .set_json(serde_json::json!({ "name": "Platform Team" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        // Member can see both in the org-scoped lists.
        let req = actix_test::TestRequest::get()
            .uri("/projects")
            .insert_header(("Authorization", bearer(member_id, &member_email)))
            .to_request();
        let projects: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(projects.as_array().map(|a| a.len()), Some(1));

        let req = actix_test::TestRequest::get()
            .uri("/teams")
            .insert_header(("Authorization", bearer(member_id, &member_email)))
            .to_request();
        let teams: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(teams.as_array().map(|a| a.len()), Some(1));
        assert_eq!(teams[0]["slug"], "platformteam");

        // A plain member cannot create — owner-only.
        let req = actix_test::TestRequest::post()
            .uri("/projects")
            .insert_header(("Authorization", bearer(member_id, &member_email)))
            .set_json(serde_json::json!({ "name": "Sneaky" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let req = actix_test::TestRequest::post()
            .uri("/teams")
            .insert_header(("Authorization", bearer(member_id, &member_email)))
            .set_json(serde_json::json!({ "name": "Sneaky Team" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn personal_account_sees_empty_lists() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(workspace::handler::list_projects)
                .service(workspace::handler::list_teams),
        )
        .await;

        let bearer = format!("Bearer {}", jwt_for(user_id, &email));
        let req = actix_test::TestRequest::get()
            .uri("/projects")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let projects: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(projects.as_array().map(|a| a.len()), Some(0));

        let req = actix_test::TestRequest::get()
            .uri("/teams")
            .insert_header(("Authorization", bearer))
            .to_request();
        let teams: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(teams.as_array().map(|a| a.len()), Some(0));

        cleanup(&pool, &[user_id], &[]).await;
    }
}
