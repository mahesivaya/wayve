// "Fix with AI" in local runner mode (AI_FIX_RUNNER=local): the runner claims a
// queued item, then reports back that it opened the pull request, or what
// failed. Outside that mode the claim endpoint does not exist and the callback
// refuses the runner-only status.
#[cfg(test)]
mod tests {
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

    /// A queued ticket, back-dated so it is the next one any claim returns.
    async fn queued_ticket(pool: &PgPool, owner: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO workspace_tickets (user_id, name, description, ai_fix_status, updated_at)
             VALUES ($1, 'Rename the button', 'Say Save, not Submit.', 'queued',
                     TIMESTAMP '2000-01-01')
             RETURNING id",
        )
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert ticket: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn runner_claims_a_queued_fix_and_reports_the_pull_request() {
        // SAFETY: serialized via #[serial]; no other test reads this variable.
        unsafe {
            std::env::set_var("AI_FIX_RUNNER", "local");
        }
        let pool = test_pool().await;
        let email = random_email();
        let owner = make_platform_owner(&pool, &email).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let ticket = queued_ticket(&pool, owner).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::tickets::routes),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri("/workspace-tickets/ai-fix-local/claim")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["job"]["kind"], "ticket", "{body}");
        assert_eq!(body["job"]["id"], ticket);
        assert_eq!(body["job"]["title"], "Rename the button");
        assert_eq!(body["job"]["description"], "Say Save, not Submit.");

        // Claimed means running: it is not handed out a second time.
        let status: Option<String> =
            sqlx::query_scalar("SELECT ai_fix_status FROM workspace_tickets WHERE id = $1")
                .bind(ticket)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("read status: {e}"));
        assert_eq!(status.as_deref(), Some("running"));

        // A failed check: the output is kept for the item to show.
        let report = |body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri(&format!("/workspace-tickets/{ticket}/ai-fix-diff"))
                .insert_header(("Authorization", bearer.clone()))
                .set_json(body)
                .to_request()
        };
        let res = actix_test::call_service(
            &app,
            report(serde_json::json!({ "status": "error", "diff": "npm test failed" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let row = sqlx::query(
            "SELECT ai_fix_status, ai_fix_diff, ai_fix_pr_url FROM workspace_tickets WHERE id = $1",
        )
        .bind(ticket)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("read row: {e}"));
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_status").as_deref(),
            Some("error")
        );
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_diff").as_deref(),
            Some("npm test failed")
        );

        // Checks passed: the runner opened the PR itself. A PR link is required.
        let res =
            actix_test::call_service(&app, report(serde_json::json!({ "status": "pr_opened" })))
                .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = actix_test::call_service(
            &app,
            report(serde_json::json!({
                "status": "pr_opened",
                "diff": "diff --git a/x b/x",
                "base_sha": "abc123",
                "files": [{ "path": "x", "content": "eA==" }],
                "pr_url": "https://github.com/acme/app/pull/7",
                "branch": "ai-fix/ticket-1",
                "commit_sha": "def456",
            })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let row = sqlx::query(
            "SELECT ai_fix_status, ai_fix_pr_url, ai_fix_branch, ai_fix_commit_sha
             FROM workspace_tickets WHERE id = $1",
        )
        .bind(ticket)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("read row: {e}"));
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_status").as_deref(),
            Some("pr_opened")
        );
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_pr_url").as_deref(),
            Some("https://github.com/acme/app/pull/7")
        );
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_branch").as_deref(),
            Some("ai-fix/ticket-1")
        );
        assert_eq!(
            row.get::<Option<String>, _>("ai_fix_commit_sha").as_deref(),
            Some("def456")
        );

        // Outside local runner mode there is no claim, and CI cannot report a
        // pull request it never opens.
        unsafe {
            std::env::remove_var("AI_FIX_RUNNER");
        }
        let req = actix_test::TestRequest::post()
            .uri("/workspace-tickets/ai-fix-local/claim")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = actix_test::call_service(
            &app,
            report(serde_json::json!({
                "status": "pr_opened",
                "pr_url": "https://github.com/acme/app/pull/8",
            })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(owner)
            .execute(&pool)
            .await;
    }

    // On a developer's machine the people clicking the button own the board the
    // story is on. In local runner mode an organization owner may queue a fix
    // for their own story; a plain member may not, and neither may outside that
    // mode. The runner then reports with its shared token, having no user.
    #[actix_web::test]
    #[serial_test::serial]
    async fn org_owner_queues_a_story_and_the_runner_reports_with_its_token() {
        // SAFETY: serialized via #[serial]; no other test reads these variables.
        unsafe {
            std::env::set_var("AI_FIX_RUNNER", "local");
            std::env::set_var("AI_FIX_RUNNER_TOKEN", "local-runner-test-token");
        }
        let pool = test_pool().await;
        let org: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("AI Fix Org {}", random_email()))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("insert org: {e}"));
        let mut users = Vec::new();
        let mut bearers = Vec::new();
        for role in ["owner", "member"] {
            let email = random_email();
            let id = insert_local_user(&pool, &email, "password123").await;
            sqlx::query(
                "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
            )
            .bind(org)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("attach user: {e}"));
            sqlx::query(
                "INSERT INTO organization_members (organization_id, user_id, role)
                 VALUES ($1, $2, $3)",
            )
            .bind(org)
            .bind(id)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("set role: {e}"));
            users.push(id);
            bearers.push(format!("Bearer {}", jwt_for(id, &email)));
        }
        let story: i32 = sqlx::query_scalar(
            "INSERT INTO user_stories (organization_id, name, description, priority)
             VALUES ($1, 'Remove the banner', 'It is no longer needed.', 5)
             RETURNING id",
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert story: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::user_stories::routes),
        )
        .await;
        let start = |bearer: &str| {
            actix_test::TestRequest::post()
                .uri(&format!("/user-stories/{story}/ai-fix"))
                .insert_header(("Authorization", bearer.to_string()))
                .to_request()
        };
        let status = || async {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT ai_fix_status FROM user_stories WHERE id = $1",
            )
            .bind(story)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("read status: {e}"))
        };

        let res = actix_test::call_service(&app, start(&bearers[1])).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "a member may not");
        let body: serde_json::Value =
            actix_test::call_and_read_body_json(&app, start(&bearers[0])).await;
        assert_eq!(body["runner"], "local", "{body}");
        assert_eq!(status().await.as_deref(), Some("queued"));

        // The runner has no user: its token is its credential.
        let report = |token: &str| {
            actix_test::TestRequest::post()
                .uri(&format!("/user-stories/{story}/ai-fix-diff"))
                .insert_header(("X-AI-Fix-Runner-Token", token.to_string()))
                .set_json(serde_json::json!({ "status": "no_change" }))
                .to_request()
        };
        let res = actix_test::call_service(&app, report("not-the-runner-token")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(status().await.as_deref(), Some("queued"));
        let res = actix_test::call_service(&app, report("local-runner-test-token")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(status().await.as_deref(), Some("no_change"));

        // Outside local runner mode the owner is refused, as before, and the
        // token means nothing.
        unsafe {
            std::env::remove_var("AI_FIX_RUNNER");
        }
        let res = actix_test::call_service(&app, start(&bearers[0])).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = actix_test::call_service(&app, report("local-runner-test-token")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        unsafe {
            std::env::remove_var("AI_FIX_RUNNER_TOKEN");
        }

        for id in users {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org)
            .execute(&pool)
            .await;
    }
}
