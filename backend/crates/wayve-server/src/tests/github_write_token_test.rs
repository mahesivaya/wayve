// GitHub writes made through the proxy (commit comment, PR approve) on behalf
// of a personal account, against a mocked GitHub (wiremock via
// GITHUB_API_BASE). A personal account that never connected GitHub is refused
// before anything reaches GitHub: the shared server PAT is never lent to it.
// Once it connects, the write goes out as its own token. A malformed repo name
// is refused with 400 before any GitHub call.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const SHARED_TOKEN: &str = "ghp_shared_server_token";
    const USER_TOKEN: &str = "gho_personal_user_token";
    const SHA: &str = "abc1234";

    async fn link_personal_project(pool: &PgPool, user_id: i32, owner: &str, repo: &str) {
        sqlx::query(
            "INSERT INTO projects (name, user_id, github_owner, github_repo)
             VALUES ('P', $1, $2, $3)",
        )
        .bind(user_id)
        .bind(owner)
        .bind(repo)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert project: {e}"));
    }

    async fn connect_github(pool: &PgPool, user_id: i32) {
        let (iv, ciphertext) = wayve_security::encryption::encrypt(USER_TOKEN)
            .unwrap_or_else(|e| panic!("encrypt token: {e:?}"));
        sqlx::query(
            "INSERT INTO github_accounts (user_id, github_login, access_token_iv, access_token_encrypted)
             VALUES ($1, 'personal-login', $2, $3)",
        )
        .bind(user_id)
        .bind(iv)
        .bind(ciphertext)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("connect github: {e}"));
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        for sql in [
            "DELETE FROM github_accounts WHERE user_id = $1",
            "DELETE FROM projects WHERE user_id = $1",
            "DELETE FROM users WHERE id = $1",
        ] {
            let _ = sqlx::query(sql).bind(user_id).execute(pool).await;
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn personal_writes_need_their_own_github() {
        let suffix = random_email().replace(['@', '.'], "-");
        let owner = "acme";
        let repo = format!("pub-{suffix}");
        let comment_path = format!("/repos/{owner}/{repo}/commits/{SHA}/comments");

        let mock = MockServer::start().await;
        // Only the connected user's own token may ever reach GitHub.
        Mock::given(method("POST"))
            .and(path(comment_path.clone()))
            .and(header(
                "Authorization",
                format!("Bearer {USER_TOKEN}").as_str(),
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 1 })))
            .expect(1)
            .mount(&mock)
            .await;
        // Anything sent with the shared PAT would be the bug this guards.
        Mock::given(method("POST"))
            .and(header(
                "Authorization",
                format!("Bearer {SHARED_TOKEN}").as_str(),
            ))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial]; points GitHub calls at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
            std::env::set_var("GITHUB_TOKEN", SHARED_TOKEN);
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
        }

        let pool = test_pool().await;
        let email = random_email();
        let user = insert_local_user(&pool, &email, "password123").await;
        link_personal_project(&pool, user, owner, &repo).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_proxy::create_commit_comment)
                .service(crate::github_proxy::approve_pull_request),
        )
        .await;
        let bearer = format!("Bearer {}", jwt_for(user, &email));
        let call = |uri: String| {
            actix_test::TestRequest::post()
                .uri(&uri)
                .insert_header(("Authorization", bearer.clone()))
                .set_json(serde_json::json!({ "body": "hello" }))
                .to_request()
        };
        let comment_uri = format!("/github/repos/{owner}/{repo}/commits/{SHA}/comments");

        // Not connected: refused, nothing sent upstream.
        let res = actix_test::call_service(&app, call(comment_uri.clone())).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value = actix_test::read_body_json(res).await;
        assert!(
            body["message"]
                .as_str()
                .unwrap_or("")
                .contains("Connect your GitHub"),
            "{body}"
        );
        let res = actix_test::call_service(
            &app,
            call(format!("/github/repos/{owner}/{repo}/pulls/7/approve")),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // A malformed name is refused before any gate or GitHub call.
        let res = actix_test::call_service(
            &app,
            call(format!(
                "/github/repos/{owner}/bad%20name/commits/{SHA}/comments"
            )),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Connected: the comment goes out as the user's own token.
        connect_github(&pool, user).await;
        let res = actix_test::call_service(&app, call(comment_uri)).await;
        assert_eq!(res.status(), StatusCode::CREATED);

        cleanup(&pool, user).await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
            std::env::remove_var("GITHUB_TOKEN");
        }
    }
}
