// Assignee suggestion, end-to-end through the HTTP endpoint against a mocked
// GitHub (wiremock via GITHUB_API_BASE). Feeds a known repo tree + per-file
// commit history and asserts the ranking: the author with more, more-recent
// commits to the file the task maps to comes first. No AI provider is
// configured, so the story→files mapping deterministically uses the keyword
// fallback (which is what makes the assertion stable).
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, test as actix_test, web};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn mount_github(mock: &MockServer, owner: &str, repo: &str) {
        // Repo detail → default branch.
        Mock::given(method("GET"))
            .and(path(format!("/repos/{owner}/{repo}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "default_branch": "main" })),
            )
            .mount(mock)
            .await;

        // Recursive tree → two files, only one of which matches the task text.
        Mock::given(method("GET"))
            .and(path(format!("/repos/{owner}/{repo}/git/trees/main")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tree": [
                    { "type": "blob", "path": "src/email/sync.rs" },
                    { "type": "blob", "path": "src/chat/websocket.rs" }
                ]
            })))
            .mount(mock)
            .await;

        // Commit history for the matched file: alice x3 (recent), bob x1 (old).
        let recent = (Utc::now() - Duration::days(3)).to_rfc3339();
        let old = (Utc::now() - Duration::days(600)).to_rfc3339();
        Mock::given(method("GET"))
            .and(path(format!("/repos/{owner}/{repo}/commits")))
            .and(query_param("path", "src/email/sync.rs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "author": { "login": "alice" }, "commit": { "author": { "name": "Alice", "date": recent } } },
                { "author": { "login": "alice" }, "commit": { "author": { "name": "Alice", "date": recent } } },
                { "author": { "login": "alice" }, "commit": { "author": { "name": "Alice", "date": recent } } },
                { "author": { "login": "bob" },   "commit": { "author": { "name": "Bob",   "date": old } } }
            ])))
            .mount(mock)
            .await;
    }

    async fn insert_personal_project(pool: &PgPool, user_id: i32, owner: &str, repo: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO projects (name, user_id, github_owner, github_repo)
             VALUES ('Test project', $1, $2, $3) RETURNING id",
        )
        .bind(user_id)
        .bind(owner)
        .bind(repo)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert project: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn suggest_ranks_authors_by_file_history() {
        let mock = MockServer::start().await;
        let (owner, repo) = ("acme-test", "widgets");
        mount_github(&mock, owner, repo).await;

        // SAFETY: serialized via #[serial]; points the GitHub client at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));
        let project_id = insert_personal_project(&pool, user_id, owner, repo).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::tasks::suggest::suggest_assignee),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri("/tasks/suggest-assignee")
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({
                "project_id": project_id,
                "summary": "Fix email sync worker",
                "description": ""
            }))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        // Mapped to the email file via the keyword fallback (no AI configured).
        assert_eq!(body["used_ai"], serde_json::json!(false));
        assert_eq!(
            body["files"],
            serde_json::json!(["src/email/sync.rs"]),
            "expected the email file, got {body}"
        );

        // Ranked: alice (3 recent commits) before bob (1 old commit).
        let candidates = body["candidates"]
            .as_array()
            .unwrap_or_else(|| panic!("candidates not an array: {body}"));
        assert_eq!(candidates.len(), 2, "expected two authors: {body}");
        assert_eq!(candidates[0]["github_login"], serde_json::json!("alice"));
        assert_eq!(candidates[0]["commits"], serde_json::json!(3));
        assert_eq!(candidates[0]["recent_commits"], serde_json::json!(3));
        assert_eq!(candidates[1]["github_login"], serde_json::json!("bob"));
        // Personal scope has no team, so neither is assignable — both reference.
        assert_eq!(candidates[0]["is_reference_only"], serde_json::json!(true));
        assert!(
            candidates[0]["expertise_score"].as_f64().unwrap_or(0.0)
                > candidates[1]["expertise_score"].as_f64().unwrap_or(0.0)
        );

        // Cleanup.
        let _ = sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(project_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
        }
        drop(mock);
    }
}
