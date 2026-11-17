// "Fix with AI" progress (local runner): the runner reports how far a run has
// got, and the item shows it as a percentage. The number only moves forward,
// stops at 99 until the final report, is kept where a failed run stopped, and
// a report for a fix that is not running is ignored.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

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

    async fn ticket(pool: &PgPool, owner: i32, status: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO workspace_tickets (user_id, name, description, ai_fix_status, ai_fix_progress)
             VALUES ($1, 'Rename the button', 'Say Save, not Submit.', $2, 0)
             RETURNING id",
        )
        .bind(owner)
        .bind(status)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert ticket: {e}"))
    }

    async fn stored(pool: &PgPool, id: i32) -> (Option<i16>, Option<String>) {
        sqlx::query_as("SELECT ai_fix_progress, ai_fix_step FROM workspace_tickets WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read progress: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn progress_moves_forward_to_99_and_the_final_report_settles_it() {
        // SAFETY: serialized via #[serial]; no other test reads this variable.
        unsafe {
            std::env::set_var("AI_FIX_RUNNER", "local");
        }
        let pool = test_pool().await;
        let email = random_email();
        let owner = make_platform_owner(&pool, &email).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let running = ticket(&pool, owner, "running").await;
        let queued = ticket(&pool, owner, "queued").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::tickets::routes),
        )
        .await;
        let post = |id: i32, what: &str, body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri(&format!("/workspace-tickets/{id}/{what}"))
                .insert_header(("Authorization", bearer.clone()))
                .set_json(body)
                .to_request()
        };
        let report = |id: i32, percent: i64, step: &str| {
            post(
                id,
                "ai-fix-progress",
                serde_json::json!({ "percent": percent, "step": step }),
            )
        };

        // No credentials: refused.
        let anonymous = actix_test::TestRequest::post()
            .uri(&format!("/workspace-tickets/{running}/ai-fix-progress"))
            .set_json(serde_json::json!({ "percent": 50 }))
            .to_request();
        let res = actix_test::call_service(&app, anonymous).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let body: serde_json::Value =
            actix_test::call_and_read_body_json(&app, report(running, 40, "  Claude is working  "))
                .await;
        assert_eq!(body["recorded"], true, "{body}");
        assert_eq!(
            stored(&pool, running).await,
            (Some(40), Some("Claude is working".to_string()))
        );

        // A lower number does not move it back; the step still updates.
        actix_test::call_service(&app, report(running, 10, "Checking: cargo clippy")).await;
        assert_eq!(
            stored(&pool, running).await,
            (Some(40), Some("Checking: cargo clippy".to_string()))
        );

        // Only the final report reaches 100.
        actix_test::call_service(&app, report(running, 250, "Opening the pull request")).await;
        assert_eq!(stored(&pool, running).await.0, Some(99));

        // The item reads it back.
        let state = actix_test::TestRequest::get()
            .uri(&format!("/workspace-tickets/{running}/ai-fix"))
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, state).await;
        assert_eq!(body["progress"], 99, "{body}");
        assert_eq!(body["step"], "Opening the pull request");

        // A fix that is not running ignores a report.
        let body: serde_json::Value =
            actix_test::call_and_read_body_json(&app, report(queued, 60, "late")).await;
        assert_eq!(body["recorded"], false, "{body}");
        assert_eq!(stored(&pool, queued).await, (Some(0), None));

        // A failed run keeps the point it reached...
        sqlx::query("UPDATE workspace_tickets SET ai_fix_progress = 75 WHERE id = $1")
            .bind(queued)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("seed progress: {e}"));
        let res = actix_test::call_service(
            &app,
            post(
                queued,
                "ai-fix-diff",
                serde_json::json!({ "status": "error", "diff": "npm test failed" }),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(stored(&pool, queued).await.0, Some(75));

        // ...and a finished one is complete, with no step left to show.
        let res = actix_test::call_service(
            &app,
            post(
                running,
                "ai-fix-diff",
                serde_json::json!({
                    "status": "pr_opened",
                    "pr_url": "https://github.com/x/y/pull/1",
                }),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(stored(&pool, running).await, (Some(100), None));

        unsafe {
            std::env::remove_var("AI_FIX_RUNNER");
        }
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("cleanup: {e}"));
    }
}
