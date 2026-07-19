// User-configurable task statuses: lazy default seeding, CRUD, the delete
// guards, and — the reason this feature is risky — that an unknown status slug
// is now rejected instead of silently rewriting the task.
#[cfg(test)]
mod tests {
    use crate::tasks;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

    async fn cleanup(pool: &PgPool, user_id: i32) {
        // tasks + task_statuses both cascade from users on delete.
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    /// Personal accounts resolve to Role::Owner, so they hold
    /// `task_statuses:manage` and can drive every endpoint here.
    ///
    /// This is a macro rather than a function because `init_service` returns an
    /// unnameable opaque type: returning it would need `actix_http::Request`,
    /// which isn't a direct dependency of this crate.
    macro_rules! app_for {
        ($pool:expr) => {{
            let email = random_email();
            let user_id = insert_local_user($pool, &email, "pw123456").await;
            let token = jwt_for(user_id, &email);
            let app = actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($pool.clone()))
                    .configure(tasks::routes),
            )
            .await;
            (app, user_id, token)
        }};
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn seeds_defaults_on_first_read() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        let req = actix_test::TestRequest::get()
            .uri("/task-statuses")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let list = body.as_array().unwrap_or_else(|| panic!("expected array"));

        assert_eq!(list.len(), 4, "the four legacy statuses should seed");
        // Slugs must match the values the old CHECK constraint allowed, or
        // existing tasks would be orphaned on a status that no longer exists.
        let slugs: Vec<&str> = list.iter().filter_map(|s| s["slug"].as_str()).collect();
        assert_eq!(slugs, vec!["to_do", "in_progress", "in_review", "done"]);
        assert_eq!(list[3]["category"], "completed");

        // Reading twice must not double-seed.
        let req = actix_test::TestRequest::get()
            .uri("/task-statuses")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let again: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(again.as_array().map(Vec::len), Some(4));

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn creates_status_with_custom_color_and_derived_slug() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        let req = actix_test::TestRequest::post()
            .uri("/task-statuses")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "name": "QA Review",
                "category": "in_progress",
                "color": "#AB12CD",
                "description": "Waiting on QA"
            }))
            .to_request();
        let created: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        assert_eq!(created["slug"], "qa_review");
        // Colors are normalised to lowercase to match the column's CHECK.
        assert_eq!(created["color"], "#ab12cd");
        assert_eq!(created["category"], "in_progress");

        // A task may now be created on the custom status.
        let req = actix_test::TestRequest::post()
            .uri("/tasks")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "name": "Ship it", "status": "qa_review" }))
            .to_request();
        let task: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(task["status"], "qa_review");

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn rejects_invalid_color_and_category() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        for bad in [
            serde_json::json!({ "name": "X", "category": "in_progress", "color": "red" }),
            serde_json::json!({ "name": "X", "category": "nonsense" }),
            serde_json::json!({ "name": "   ", "category": "backlog" }),
        ] {
            let req = actix_test::TestRequest::post()
                .uri("/task-statuses")
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(&bad)
                .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "payload: {bad}");
        }

        cleanup(&pool, user_id).await;
    }

    /// The regression this whole design exists to prevent. The old
    /// `normalize_status` had a `_ => "to_do"` arm, so a status the server
    /// didn't recognise silently rewrote the task instead of failing.
    #[actix_web::test]
    #[serial_test::serial]
    async fn unknown_status_is_rejected_not_silently_reset() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        let req = actix_test::TestRequest::post()
            .uri("/tasks")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "name": "T", "status": "not_a_real_status" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Nothing was written.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|err| panic!("count tasks: {err}"));
        assert_eq!(count, 0, "a rejected status must not create a task");

        // Omitting status entirely is still fine, and lands on the first status.
        let req = actix_test::TestRequest::post()
            .uri("/tasks")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "name": "T" }))
            .to_request();
        let task: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(task["status"], "to_do");

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn delete_refuses_when_in_use_then_reassigns() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        // Seed, then put a task on "in_review".
        let req = actix_test::TestRequest::get()
            .uri("/task-statuses")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let list: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let in_review = list
            .as_array()
            .and_then(|l| l.iter().find(|s| s["slug"] == "in_review"))
            .unwrap_or_else(|| panic!("in_review missing"));
        let in_review_id = in_review["id"].as_i64().unwrap_or_else(|| panic!("no id"));

        let req = actix_test::TestRequest::post()
            .uri("/tasks")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "name": "Busy", "status": "in_review" }))
            .to_request();
        let _: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        // Deleting a status tasks still reference must fail, not strand them.
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/task-statuses/{in_review_id}"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // With an explicit destination it succeeds and moves the task.
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/task-statuses/{in_review_id}?reassign_to=done"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let moved: String =
            sqlx::query("SELECT status FROM tasks WHERE user_id = $1 AND name = 'Busy'")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .map(|r| r.get("status"))
                .unwrap_or_else(|err| panic!("fetch task: {err}"));
        assert_eq!(moved, "done");

        cleanup(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reorder_rewrites_positions_densely() {
        let pool = test_pool().await;
        let (app, user_id, token) = app_for!(&pool);

        let req = actix_test::TestRequest::get()
            .uri("/task-statuses")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let list: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let mut ids: Vec<i64> = list
            .as_array()
            .unwrap_or_else(|| panic!("expected array"))
            .iter()
            .filter_map(|s| s["id"].as_i64())
            .collect();
        ids.reverse();

        let req = actix_test::TestRequest::put()
            .uri("/task-statuses/reorder")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({ "ids": ids }))
            .to_request();
        let reordered: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        let slugs: Vec<&str> = reordered
            .as_array()
            .unwrap_or_else(|| panic!("expected array"))
            .iter()
            .filter_map(|s| s["slug"].as_str())
            .collect();
        assert_eq!(slugs, vec!["done", "in_review", "in_progress", "to_do"]);

        cleanup(&pool, user_id).await;
    }
}
