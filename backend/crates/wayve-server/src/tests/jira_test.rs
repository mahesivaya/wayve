// The Jira integration end to end: connecting with the credential encrypted at
// rest, importing issues into tasks idempotently, and pushing a linked task's
// status change back to Jira. Jira is mocked with wiremock via the
// `JIRA_API_BASE` indirection.
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

    fn search_body() -> serde_json::Value {
        serde_json::json!({
            "issues": [
                {
                    "key": "WAY-1",
                    "fields": {
                        "summary": "First issue",
                        "description": null,
                        "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                        "priority": { "name": "High" }
                    }
                },
                {
                    "key": "WAY-2",
                    "fields": {
                        "summary": "Second issue",
                        "description": "plain text body",
                        "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                        "priority": { "name": "Lowest" }
                    }
                }
            ]
        })
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        // tasks + user_jira_connections cascade from users on delete.
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn connect_import_and_push() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/rest/api/3/myself"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accountId": "abc", "emailAddress": "dev@example.com"
            })))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/3/search/jql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(search_body()))
            .mount(&mock)
            .await;
        Mock::given(method("PUT"))
            .and(path("/rest/api/3/issue/WAY-1"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/3/issue/WAY-1/transitions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "transitions": [ { "id": "31", "to": { "statusCategory": { "key": "done" } } } ]
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/rest/api/3/issue/WAY-1/transitions"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;

        // SAFETY: this mutates process env, so the test is #[serial] (and CI
        // runs --test-threads=1) to keep it from racing other tests.
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("JIRA_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::jira::handler::get_connection)
                .service(integrations::jira::handler::connect)
                .service(integrations::jira::handler::disconnect)
                .service(integrations::jira::handler::import_issues)
                .service(tasks::handler::list_tasks)
                .service(tasks::handler::update_task),
        )
        .await;

        let req = actix_test::TestRequest::put()
            .uri("/integrations/jira/connection")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "base_url": "https://acme.atlassian.net/",
                "email": "dev@example.com",
                "api_token": "s3cr3t-token"
            }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The token must be at rest only as ciphertext, and the base URL is
        // stored normalized.
        let row = sqlx::query(
            "SELECT base_url, api_token_iv, api_token_encrypted
             FROM user_jira_connections WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("connection row: {e}"));
        let base_url: String = row.get("base_url");
        assert_eq!(base_url, "https://acme.atlassian.net");
        let iv: String = row.get("api_token_iv");
        let enc: String = row.get("api_token_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "s3cr3t-token");

        let req = actix_test::TestRequest::post()
            .uri("/integrations/jira/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 2);
        assert_eq!(body["updated"], 0);

        // Re-importing the same issues updates them in place instead of
        // duplicating them.
        let req = actix_test::TestRequest::post()
            .uri("/integrations/jira/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 0);
        assert_eq!(body["updated"], 2);

        let req = actix_test::TestRequest::get()
            .uri("/tasks")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let tasks_json: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let arr = tasks_json.as_array().expect("tasks array");
        assert_eq!(arr.len(), 2);
        let way1 = arr
            .iter()
            .find(|t| t["jira_issue_key"] == "WAY-1")
            .expect("WAY-1 task");
        assert_eq!(way1["status"], "to_do");
        assert_eq!(way1["priority"], 4);
        assert_eq!(way1["jira_base"], "https://acme.atlassian.net");
        let task_id = way1["id"].as_i64().expect("task id") as i32;

        // Editing a linked task to "done" must push a transition back to Jira.
        let req = actix_test::TestRequest::put()
            .uri(&format!("/tasks/{task_id}"))
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "name": "First issue", "status": "done" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The expected transition POST is verified when `mock` drops below.
        drop(app);
        mock.verify().await;

        unsafe {
            std::env::remove_var("JIRA_API_BASE");
        }
        cleanup(&pool, user_id).await;
    }
}
