// Per-repo access, end-to-end through the HTTP endpoints against a mocked GitHub
// (wiremock via GITHUB_API_BASE). Covers: the merged access grid (GitHub
// collaborators + Wayve grants + login→user mapping), an add that syncs to
// GitHub, and the token-lacks-admin (403) path that still succeeds Wayve-side.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const OWNER: &str = "acme-access";
    const REPO: &str = "widgets";

    async fn personal_project(pool: &PgPool, user_id: i32) {
        sqlx::query(
            "INSERT INTO projects (name, user_id, github_owner, github_repo)
             VALUES ('P', $1, $2, $3)",
        )
        .bind(user_id)
        .bind(OWNER)
        .bind(REPO)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert project: {e}"));
    }

    async fn map_github(pool: &PgPool, user_id: i32, login: &str) {
        sqlx::query(
            "INSERT INTO github_accounts (user_id, github_login, access_token_iv, access_token_encrypted)
             VALUES ($1, $2, 'iv', 'enc')",
        )
        .bind(user_id)
        .bind(login)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("map github: {e}"));
    }

    async fn grant(pool: &PgPool, user_id: i32, level: &str) {
        sqlx::query(
            "INSERT INTO member_project_access (user_id, repo_full_name, access_level)
             VALUES ($1, $2, $3)",
        )
        .bind(user_id)
        .bind(format!("{OWNER}/{REPO}"))
        .bind(level)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("grant: {e}"));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn grid_merges_github_and_wayve_then_add() {
        let mock = MockServer::start().await;
        // Collaborators: alice=write (push), bob=read (pull only).
        Mock::given(method("GET"))
            .and(path(format!("/repos/{OWNER}/{REPO}/collaborators")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "login": "alice", "permissions": { "admin": false, "push": true,  "pull": true } },
                { "login": "bob",   "permissions": { "admin": false, "push": false, "pull": true } }
            ])))
            .mount(&mock)
            .await;
        // Add carol → GitHub accepts (204). Add dave → 403 (no admin token).
        Mock::given(method("PUT"))
            .and(path(format!("/repos/{OWNER}/{REPO}/collaborators/carol")))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;
        Mock::given(method("PUT"))
            .and(path(format!("/repos/{OWNER}/{REPO}/collaborators/dave")))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial]; points the GitHub client at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        // Caller owns the personal project; a separate member maps to "alice".
        let caller_email = random_email();
        let caller = insert_local_user(&pool, &caller_email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(caller, &caller_email));
        personal_project(&pool, caller).await;

        let member = insert_local_user(&pool, &random_email(), "password123").await;
        map_github(&pool, member, "alice").await;
        grant(&pool, member, "write").await; // alice is in the dashboard

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::repo_access::handler::get_access)
                .service(crate::repo_access::handler::set_access),
        )
        .await;

        // ---- GET the grid ----
        let req = actix_test::TestRequest::get()
            .uri(&format!("/repos/{OWNER}/{REPO}/access"))
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        assert_eq!(body["github_readable"], serde_json::json!(true));
        assert_eq!(body["can_manage"], serde_json::json!(true));
        let rows = body["rows"]
            .as_array()
            .unwrap_or_else(|| panic!("rows: {body}"));
        assert_eq!(rows.len(), 2, "expected alice + bob: {body}");

        let alice = rows
            .iter()
            .find(|r| r["github_login"] == serde_json::json!("alice"))
            .unwrap_or_else(|| panic!("no alice row: {body}"));
        assert_eq!(alice["level"], serde_json::json!("write"));
        assert_eq!(alice["is_member"], serde_json::json!(true));
        assert_eq!(alice["user_id"], serde_json::json!(member));
        assert_eq!(alice["in_dashboard"], serde_json::json!(true));
        assert_eq!(alice["source"], serde_json::json!("both"));

        let bob = rows
            .iter()
            .find(|r| r["github_login"] == serde_json::json!("bob"))
            .unwrap_or_else(|| panic!("no bob row: {body}"));
        assert_eq!(bob["level"], serde_json::json!("read"));
        assert_eq!(bob["is_member"], serde_json::json!(false));
        assert_eq!(bob["user_id"], serde_json::json!(null));
        assert_eq!(bob["source"], serde_json::json!("github"));

        // ---- Add carol (GitHub accepts) ----
        let req = actix_test::TestRequest::put()
            .uri(&format!("/repos/{OWNER}/{REPO}/access"))
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "github_login": "carol", "level": "read" }))
            .to_request();
        let res: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(res["github_outcome"], serde_json::json!("synced"));

        // ---- Add dave (token lacks admin → 403, Wayve side still fine) ----
        let req = actix_test::TestRequest::put()
            .uri(&format!("/repos/{OWNER}/{REPO}/access"))
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({ "github_login": "dave", "level": "write" }))
            .to_request();
        let res: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(res["github_outcome"], serde_json::json!("forbidden"));
        assert!(res["note"].as_str().unwrap_or("").contains("admin"));

        // Cleanup.
        for uid in [caller, member] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
        }
        drop(mock);
    }
}
