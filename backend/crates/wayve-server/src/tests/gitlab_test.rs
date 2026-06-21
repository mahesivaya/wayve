// GitLab integration end-to-end: connect (token validated via GET /user,
// encrypted at rest), import assigned issues → tasks (with state/label mapping),
// and idempotent re-import. GitLab is mocked via wiremock and `GITLAB_API_BASE`.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::{integrations, tasks};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::decrypt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn issues_body() -> serde_json::Value {
        serde_json::json!([
            {
                "iid": 1, "project_id": 10, "title": "First issue",
                "description": "body one", "state": "opened",
                "labels": [], "web_url": "https://gitlab.com/acme/app/-/issues/1"
            },
            {
                "iid": 2, "project_id": 10, "title": "Second issue",
                "description": "body two", "state": "closed",
                "labels": ["priority::high"],
                "web_url": "https://gitlab.com/acme/app/-/issues/2"
            }
        ])
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        // tasks + user_gitlab_connections cascade from users on delete.
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn connect_and_import() {
        let mock = MockServer::start().await;

        // Credential probe at connect time.
        Mock::given(method("GET"))
            .and(path("/api/v4/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7, "username": "dev"
            })))
            .mount(&mock)
            .await;
        // Assigned-issues list for import.
        Mock::given(method("GET"))
            .and(path("/api/v4/issues"))
            .respond_with(ResponseTemplate::new(200).set_body_json(issues_body()))
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial] — env mutation can't race other tests.
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("GITLAB_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::gitlab::handler::get_connection)
                .service(integrations::gitlab::handler::connect)
                .service(integrations::gitlab::handler::import_issues)
                .service(tasks::handler::list_tasks),
        )
        .await;

        // --- Connect: token validated then stored encrypted at rest. ---
        let req = actix_test::TestRequest::put()
            .uri("/integrations/gitlab/connection")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "base_url": "https://gitlab.com/",
                "access_token": "glpat-secret"
            }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let row = sqlx::query(
            "SELECT base_url, access_token_iv, access_token_encrypted
             FROM user_gitlab_connections WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("connection row: {e}"));
        let base_url: String = row.get("base_url");
        assert_eq!(base_url, "https://gitlab.com");
        let iv: String = row.get("access_token_iv");
        let enc: String = row.get("access_token_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "glpat-secret");

        // --- Import: two issues become two tasks, mapped. ---
        let req = actix_test::TestRequest::post()
            .uri("/integrations/gitlab/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 2);
        assert_eq!(body["updated"], 0);

        // Re-import the same issues → updated in place, not duplicated.
        let req = actix_test::TestRequest::post()
            .uri("/integrations/gitlab/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 0);
        assert_eq!(body["updated"], 2);

        // List tasks: two, with the mapped status/priority + GitLab link.
        let req = actix_test::TestRequest::get()
            .uri("/tasks")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let tasks_json: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let arr = tasks_json.as_array().expect("tasks array");
        assert_eq!(arr.len(), 2);

        let first = arr
            .iter()
            .find(|t| t["gitlab_issue_iid"] == 1)
            .expect("issue #1 task");
        assert_eq!(first["status"], "to_do");
        assert_eq!(first["priority"], 3);
        assert_eq!(
            first["gitlab_web_url"],
            "https://gitlab.com/acme/app/-/issues/1"
        );

        let second = arr
            .iter()
            .find(|t| t["gitlab_issue_iid"] == 2)
            .expect("issue #2 task");
        assert_eq!(second["status"], "done");
        assert_eq!(second["priority"], 4);

        drop(app);
        unsafe {
            std::env::remove_var("GITLAB_API_BASE");
        }
        cleanup(&pool, user_id).await;
    }
}
