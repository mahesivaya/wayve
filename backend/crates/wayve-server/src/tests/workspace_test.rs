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

    // Insert an org project directly and return its id.
    async fn insert_org_project(pool: &PgPool, org_id: i32, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO projects (organization_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(org_id)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert project: {e}"))
    }

    // A plain org member cannot link a repo — the require_owner gate rejects
    // before any GitHub validation runs, so this needs no network.
    #[actix_web::test]
    async fn org_member_cannot_link_repo() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("WS Org {}", random_email())).await;
        let project_id = insert_org_project(&pool, org_id, "Apollo").await;

        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "password123").await;
        place_in_org(&pool, member_id, org_id, "member").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(workspace::handler::link_project_repo),
        )
        .await;

        let req = actix_test::TestRequest::patch()
            .uri(&format!("/projects/{project_id}/repo"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(member_id, &member_email)),
            ))
            .set_json(serde_json::json!({ "repo_url": "https://github.com/octocat/Hello-World" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[member_id], &[org_id]).await;
    }

    // An org OWNER links a public repo (GitHub validation mocked via wiremock),
    // then a plain member of the same org can read it through the proxy
    // allowlist while a repo that was never linked is refused.
    #[actix_web::test]
    #[serial_test::serial]
    async fn owner_links_repo_then_org_member_can_read_via_proxy() {
        use crate::github_proxy;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock = MockServer::start().await;
        // Both the repo-validation lookup (link) and the proxy fetch hit
        // GET /repos/octocat/Hello-World. One mock serves both: the body
        // satisfies validation (public, canonical owner/name); the proxy just
        // forwards it and the test only asserts the status.
        Mock::given(method("GET"))
            .and(path("/repos/octocat/Hello-World"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "Hello-World",
                "private": false,
                "owner": { "login": "octocat" }
            })))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial] — env mutation can't race other tests.
        // One base covers both the repo validation and the proxy upstream.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("WS Org {}", random_email())).await;
        let project_id = insert_org_project(&pool, org_id, "Apollo").await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "password123").await;
        place_in_org(&pool, member_id, org_id, "member").await;
        // Code Repo defaults to owner/super_admin/admin/developer, so a plain
        // member is blocked by the feature gate before ever reaching the per-repo
        // allowlist this test exercises. The org owner has enabled Code Repo for
        // members here (an org_feature_access row); without it the member 403s.
        sqlx::query(
            "INSERT INTO organization_feature_access (organization_id, feature_key, role) \
             VALUES ($1, 'code_repo', 'member') ON CONFLICT DO NOTHING",
        )
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed org feature access: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(workspace::handler::link_project_repo)
                .service(github_proxy::github_proxy),
        )
        .await;

        // Owner links the public repo → 200.
        let req = actix_test::TestRequest::patch()
            .uri(&format!("/projects/{project_id}/repo"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(owner_id, &owner_email)),
            ))
            .set_json(serde_json::json!({ "repo_url": "https://github.com/octocat/Hello-World" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Member reads the LINKED repo via the proxy → 200 (org-wide visibility).
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/octocat/Hello-World")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(member_id, &member_email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Member reads a NON-linked repo → 403 (allowlist).
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/torvalds/linux")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(member_id, &member_email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
        }
        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    // Pull requests are OWNER-only: an org owner reads them through the proxy,
    // but a non-owner ADMIN — who CAN still read the rest of the (linked) repo,
    // since "admin" is in code_repo's default roles — is refused both the PR
    // list and a PR's issue-comment conversation. Using admin (not a plain
    // member) isolates the new PR gate from the pre-existing code_repo feature
    // gate, which already excludes members.
    #[actix_web::test]
    #[serial_test::serial]
    async fn pull_requests_are_owner_only_via_proxy() {
        use crate::github_proxy;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock = MockServer::start().await;
        // Repo validation (link) + the non-PR repo read both hit this path.
        Mock::given(method("GET"))
            .and(path("/repos/octocat/Hello-World"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "Hello-World",
                "private": false,
                "owner": { "login": "octocat" }
            })))
            .mount(&mock)
            .await;
        // The PR list upstream — only the OWNER ever reaches it.
        Mock::given(method("GET"))
            .and(path("/repos/octocat/Hello-World/pulls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial] — env mutation can't race other tests.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("WS Org {}", random_email())).await;
        let project_id = insert_org_project(&pool, org_id, "Apollo").await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        let admin_email = random_email();
        let admin_id = insert_local_user(&pool, &admin_email, "password123").await;
        place_in_org(&pool, admin_id, org_id, "admin").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(workspace::handler::link_project_repo)
                .service(github_proxy::github_proxy),
        )
        .await;

        // Owner links the repo so it's on the org allowlist.
        let req = actix_test::TestRequest::patch()
            .uri(&format!("/projects/{project_id}/repo"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(owner_id, &owner_email)),
            ))
            .set_json(serde_json::json!({ "repo_url": "https://github.com/octocat/Hello-World" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        let owner_bearer = format!("Bearer {}", jwt_for(owner_id, &owner_email));
        let admin_bearer = format!("Bearer {}", jwt_for(admin_id, &admin_email));

        // OWNER reads the PR list → 200.
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/octocat/Hello-World/pulls")
            .insert_header(("Authorization", owner_bearer))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        // ADMIN (non-owner) reads the repo itself (non-PR) → 200: only PRs are
        // gated, not the whole Code Repo feature.
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/octocat/Hello-World")
            .insert_header(("Authorization", admin_bearer.clone()))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        // ADMIN reads the PR list → 403, even though the repo is linked and the
        // admin can read everything else.
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/octocat/Hello-World/pulls")
            .insert_header(("Authorization", admin_bearer.clone()))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        // ADMIN reads a PR's conversation (issue comments) → 403.
        let req = actix_test::TestRequest::get()
            .uri("/github/repos/octocat/Hello-World/issues/5/comments")
            .insert_header(("Authorization", admin_bearer))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
        }
        cleanup(&pool, &[owner_id, admin_id], &[org_id]).await;
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
