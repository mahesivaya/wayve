// A platform owner who connected their own GitHub, end-to-end through the proxy
// against a mocked GitHub (wiremock via GITHUB_API_BASE). In admin mode their
// own token is tried first, so their private repos open; a repo only the shared
// token can see falls back to it; out of admin mode (normal session) the owner
// is a member and the own token is not used. The importable list is the shared
// token's repos plus the owner's.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, jwt_for_mode, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const USER_TOKEN: &str = "gho_platform_owner_token";
    const SHARED_TOKEN: &str = "ghp_shared_server_token";

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

    async fn connect_github(pool: &PgPool, user_id: i32) {
        let (iv, ciphertext) = wayve_security::encryption::encrypt(USER_TOKEN)
            .unwrap_or_else(|e| panic!("encrypt token: {e:?}"));
        sqlx::query(
            "INSERT INTO github_accounts (user_id, github_login, access_token_iv, access_token_encrypted)
             VALUES ($1, 'owner-login', $2, $3)",
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
            "DELETE FROM platform_members WHERE user_id = $1",
            "DELETE FROM users WHERE id = $1",
        ] {
            let _ = sqlx::query(sql).bind(user_id).execute(pool).await;
        }
    }

    fn repo_json(full_name: &str, private: bool) -> serde_json::Value {
        let (owner, name) = full_name
            .split_once('/')
            .unwrap_or_else(|| panic!("bad full_name {full_name}"));
        serde_json::json!({
            "full_name": full_name, "name": name, "owner": { "login": owner },
            "private": private, "default_branch": "main"
        })
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn platform_owner_reads_own_private_repos_and_falls_back_to_shared() {
        // Unique names: the proxy cache is process-wide.
        let suffix = random_email().replace(['@', '.'], "-");
        let own_repo = format!("owner-login/private-{suffix}");
        let shared_repo = format!("acme/shared-{suffix}");

        let mock = MockServer::start().await;
        let user_auth = format!("Bearer {USER_TOKEN}");
        let shared_auth = format!("Bearer {SHARED_TOKEN}");
        // The owner's private repo: their token sees it, the shared one doesn't.
        Mock::given(method("GET"))
            .and(path(format!("/repos/{own_repo}")))
            .and(header("Authorization", user_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_json(&own_repo, true)))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/repos/{own_repo}")))
            .and(header("Authorization", shared_auth.as_str()))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // A repo only the shared token sees.
        Mock::given(method("GET"))
            .and(path(format!("/repos/{shared_repo}")))
            .and(header("Authorization", user_auth.as_str()))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/repos/{shared_repo}")))
            .and(header("Authorization", shared_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_json(&shared_repo, false)))
            .mount(&mock)
            .await;
        // Repo lists: the two accounts overlap on the shared repo.
        Mock::given(method("GET"))
            .and(path("/user/repos"))
            .and(header("Authorization", user_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                repo_json(&own_repo, true),
                repo_json(&shared_repo, false)
            ])))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/user/repos"))
            .and(header("Authorization", shared_auth.as_str()))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!([repo_json(&shared_repo, false)])),
            )
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
        let owner = make_platform_owner(&pool, &email).await;
        connect_github(&pool, owner).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_proxy::github_proxy)
                .service(crate::github_proxy::github_importable_repos),
        )
        .await;
        let admin_bearer = format!("Bearer {}", jwt_for(owner, &email));
        let normal_bearer = format!(
            "Bearer {}",
            jwt_for_mode(owner, &email, wayve_security::jwt::SessionMode::Normal)
        );
        let get_status = |uri: String, bearer: String| {
            let app = &app;
            async move {
                let req = actix_test::TestRequest::get()
                    .uri(&uri)
                    .insert_header(("Authorization", bearer))
                    .to_request();
                actix_test::call_service(app, req).await.status()
            }
        };

        // Admin mode: own private repo opens with the owner's token...
        assert_eq!(
            get_status(format!("/github/repos/{own_repo}"), admin_bearer.clone()).await,
            StatusCode::OK
        );
        // ...and a shared-only repo still opens, via the fallback.
        assert_eq!(
            get_status(format!("/github/repos/{shared_repo}"), admin_bearer.clone()).await,
            StatusCode::OK
        );
        // Normal mode: the owner is downscoped to member, so their own token is
        // not chosen, and the private repo stays out of reach.
        let token_for = |bearer: &str| {
            actix_test::TestRequest::default()
                .insert_header(("Authorization", bearer.to_string()))
                .to_http_request()
        };
        let admin_choice =
            crate::github_proxy::platform_owner_github_token(&token_for(&admin_bearer), &pool)
                .await;
        assert_eq!(admin_choice, Some((owner, USER_TOKEN.to_string())));
        let normal_choice =
            crate::github_proxy::platform_owner_github_token(&token_for(&normal_bearer), &pool)
                .await;
        assert_eq!(normal_choice, None);
        assert_ne!(
            get_status(format!("/github/repos/{own_repo}"), normal_bearer.clone()).await,
            StatusCode::OK
        );
        // A member in normal mode AND an owner in the DB still opens the repos
        // the shared token sees, with no per-repo grant.
        assert_eq!(
            get_status(format!("/github/repos/{shared_repo}"), normal_bearer).await,
            StatusCode::OK
        );

        // Importable list: shared repos plus the owner's, each once.
        let req = actix_test::TestRequest::get()
            .uri("/github-importable-repos")
            .insert_header(("Authorization", admin_bearer))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let names: Vec<&str> = body["repos"]
            .as_array()
            .unwrap_or_else(|| panic!("repos: {body}"))
            .iter()
            .filter_map(|r| r["full_name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![shared_repo.as_str(), own_repo.as_str()],
            "{body}"
        );

        cleanup(&pool, owner).await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
            std::env::remove_var("GITHUB_TOKEN");
        }
    }
}
