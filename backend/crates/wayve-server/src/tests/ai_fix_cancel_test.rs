// Canceling a "Fix with AI" run: a queued or running fix moves to `canceled`,
// the runner is told so on its next progress report, and a result that arrives
// afterwards is dropped instead of bringing the fix back. A fix that already
// has a result is left alone, and so is an item the caller can't see.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::{Value, json};
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

    async fn item(pool: &PgPool, table: &str, owner: i32, status: &str) -> i32 {
        sqlx::query_scalar(&format!(
            "INSERT INTO {table} (user_id, name, description, ai_fix_status, ai_fix_progress)
             VALUES ($1, 'Rename the button', 'Say Save, not Submit.', $2, 40)
             RETURNING id"
        ))
        .bind(owner)
        .bind(status)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert into {table}: {e}"))
    }

    async fn stored(pool: &PgPool, table: &str, id: i32) -> (Option<String>, Option<i16>) {
        sqlx::query_as(&format!(
            "SELECT ai_fix_status, ai_fix_progress FROM {table} WHERE id = $1"
        ))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("read {table}: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_canceled_fix_stays_canceled() {
        // SAFETY: serialized via #[serial]; no other test reads this variable.
        unsafe {
            std::env::set_var("AI_FIX_RUNNER", "local");
        }
        let pool = test_pool().await;
        let email = random_email();
        let owner = make_platform_owner(&pool, &email).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let other_email = random_email();
        let other = make_platform_owner(&pool, &other_email).await;

        let tickets = "workspace_tickets";
        let running = item(&pool, tickets, owner, "running").await;
        let queued = item(&pool, tickets, owner, "queued").await;
        let ready = item(&pool, tickets, owner, "ready").await;
        let someone_elses = item(&pool, tickets, other, "running").await;
        let story = item(&pool, "user_stories", owner, "running").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::tickets::routes)
                .configure(crate::user_stories::routes),
        )
        .await;
        let post = |uri: String, body: Value| {
            actix_test::TestRequest::post()
                .uri(&uri)
                .insert_header(("Authorization", bearer.clone()))
                .set_json(body)
                .to_request()
        };

        // A running fix is canceled, and keeps the progress it had reached.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                format!("/workspace-tickets/{running}/ai-fix-cancel"),
                json!({}),
            ),
        )
        .await;
        assert_eq!(resp["canceled"], json!(true));
        assert_eq!(
            stored(&pool, tickets, running).await,
            (Some("canceled".to_string()), Some(40))
        );

        // The runner's next progress report isn't recorded, and tells it to stop.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                format!("/workspace-tickets/{running}/ai-fix-progress"),
                json!({ "percent": 60, "step": "Running the checks" }),
            ),
        )
        .await;
        assert_eq!(resp, json!({ "recorded": false, "canceled": true }));

        // A result that arrives afterwards is dropped.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                format!("/workspace-tickets/{running}/ai-fix-diff"),
                json!({ "status": "no_change" }),
            ),
        )
        .await;
        assert_eq!(resp, json!({ "recorded": false, "canceled": true }));
        assert_eq!(
            stored(&pool, tickets, running).await,
            (Some("canceled".to_string()), Some(40))
        );

        // A queued fix is canceled too, and the runner can no longer claim it.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                format!("/workspace-tickets/{queued}/ai-fix-cancel"),
                json!({}),
            ),
        )
        .await;
        assert_eq!(resp["canceled"], json!(true));
        let claimed: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                "/workspace-tickets/ai-fix-local/claim".to_string(),
                json!({}),
            ),
        )
        .await;
        assert_ne!(
            claimed["job"]["id"],
            json!(queued),
            "claimed a canceled job"
        );
        assert_eq!(
            stored(&pool, tickets, queued).await.0,
            Some("canceled".to_string())
        );

        // A fix with a result to review has nothing to cancel and is untouched.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(
                format!("/workspace-tickets/{ready}/ai-fix-cancel"),
                json!({}),
            ),
        )
        .await;
        assert_eq!(resp["canceled"], json!(false));
        assert_eq!(
            stored(&pool, tickets, ready).await.0,
            Some("ready".to_string())
        );

        // An item on someone else's board reads as not found and keeps running.
        let resp = actix_test::call_service(
            &app,
            post(
                format!("/workspace-tickets/{someone_elses}/ai-fix-cancel"),
                json!({}),
            ),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            stored(&pool, tickets, someone_elses).await.0,
            Some("running".to_string())
        );

        // Stories cancel the same way.
        let resp: Value = actix_test::call_and_read_body_json(
            &app,
            post(format!("/user-stories/{story}/ai-fix-cancel"), json!({})),
        )
        .await;
        assert_eq!(resp["canceled"], json!(true));
        assert_eq!(
            stored(&pool, "user_stories", story).await.0,
            Some("canceled".to_string())
        );

        // Canceling needs a signed-in caller.
        let req = actix_test::TestRequest::post()
            .uri(&format!("/workspace-tickets/{ready}/ai-fix-cancel"))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
