// Inbound Jira webhook: a delivery carrying a linked issue updates the task,
// but only with the configured URL token. Covers the auth gate (503 when no
// secret is set, 401 on a wrong token) and the happy-path field sync. No Jira
// API is contacted — the payload carries the fields — so no wiremock here.
#[cfg(test)]
mod tests {
    use crate::integrations;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

    const SECRET: &str = "hYjLCAQ5coA8ifKMZUHA";
    const SITE: &str = "https://maheshiv199.atlassian.net";

    fn updated_payload() -> serde_json::Value {
        serde_json::json!({
            "webhookEvent": "jira:issue_updated",
            "issue": {
                "key": "WAY-1",
                "self": format!("{SITE}/rest/api/2/issue/10001"),
                "fields": {
                    "summary": "Updated summary",
                    "description": "new body",
                    "status": { "name": "Done", "statusCategory": { "key": "done" } },
                    "priority": { "name": "High" }
                }
            }
        })
    }

    async fn seed_linked_task(pool: &PgPool, user_id: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO tasks
                (user_id, name, description, priority, status, jira_issue_key, jira_base)
             VALUES ($1, 'Old name', 'old', 3, 'to_do', 'WAY-1', $2)
             RETURNING id",
        )
        .bind(user_id)
        .bind(SITE)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("seed task: {e}"))
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        // tasks cascade from users on delete.
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn webhook_enforces_token_then_syncs_task() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let task_id = seed_linked_task(&pool, user_id).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::jira::webhook::jira_webhook),
        )
        .await;

        // --- No secret configured → 503, regardless of the token. ---
        // SAFETY: serialized via #[serial] — env mutation can't race other tests.
        unsafe {
            std::env::remove_var("JIRA_WEBHOOK_SECRET");
        }
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/fluxze_webhook?token=whatever")
            .set_json(updated_payload())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        // --- Secret set, wrong token → 401. ---
        unsafe {
            std::env::set_var("JIRA_WEBHOOK_SECRET", SECRET);
        }
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/fluxze_webhook?token=wrong")
            .set_json(updated_payload())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // The rejected calls left the task untouched.
        let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = $1")
            .bind(task_id)
            .fetch_one(&pool)
            .await
            .unwrap_or_default();
        assert_eq!(status, "to_do");

        // --- Valid token → task synced from the payload. ---
        let req = actix_test::TestRequest::post()
            .uri(&format!("/webhooks/fluxze_webhook?token={SECRET}"))
            .set_json(updated_payload())
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["updated"], 1);

        let row = sqlx::query("SELECT name, status, priority FROM tasks WHERE id = $1")
            .bind(task_id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("task row: {e}"));
        assert_eq!(row.get::<String, _>("name"), "Updated summary");
        assert_eq!(row.get::<String, _>("status"), "done");
        assert_eq!(row.get::<i16, _>("priority"), 4);

        unsafe {
            std::env::remove_var("JIRA_WEBHOOK_SECRET");
        }
        cleanup(&pool, user_id).await;
    }
}
