// Organizations connect their own GitHub through the Hadal GitHub App, end to end
// against a mocked GitHub (wiremock via GITHUB_API_BASE and
// GITHUB_OAUTH_TOKEN_URL):
// - the install callback records an installation only for the organization's
//   owner, and only when the GitHub user who came back can see it;
// - a connected organization imports, adds and reads its private repos with an
//   installation token, cached for that organization alone;
// - an unconnected organization is asked to connect and is never shown the
//   shared server token's repos.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use rsa::pkcs8::EncodePrivateKey;
    use sqlx::PgPool;
    use wiremock::matchers::{body_string_contains, header, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const SHARED_TOKEN: &str = "ghp_shared_server_token";
    const INSTALL_TOKEN: &str = "ghs_installation_token";
    const USER_TOKEN: &str = "ghu_installing_user_token";

    fn test_private_key() -> String {
        let mut rng = rand::thread_rng();
        let key =
            rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap_or_else(|e| panic!("generate key: {e}"));
        key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .unwrap_or_else(|e| panic!("encode key: {e}"))
            .to_string()
    }

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn org_user(pool: &PgPool, org_id: i32, role: &str) -> (i32, String) {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        let account_type = if role == "owner" {
            "organization_admin"
        } else {
            "organization"
        };
        sqlx::query("UPDATE users SET account_type = $1, organization_id = $2 WHERE id = $3")
            .bind(account_type)
            .bind(org_id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach user: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(org_id)
        .bind(id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set role: {e}"));
        (id, format!("Bearer {}", jwt_for(id, &email)))
    }

    async fn cleanup(pool: &PgPool, users: &[i32], orgs: &[i32]) {
        for id in users {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in orgs {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
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

    fn location(resp: &actix_web::dev::ServiceResponse) -> String {
        resp.headers()
            .get("Location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn organization_connects_github_and_uses_its_private_repos() {
        let suffix = random_email().replace(['@', '.'], "-");
        // GitHub logins are at most 39 characters.
        let login = format!("acme{}", rand::random::<u32>());
        let private_repo = format!("{login}/secret");
        let shared_repo = format!("server-account/{suffix}");
        // Unique per run: installation tokens are cached process-wide by id.
        let installation_id: i64 = 9_000_000 + i64::from(rand::random::<u16>());
        let foreign_installation: i64 = installation_id + 70_000;

        let mock = MockServer::start().await;
        let install_auth = format!("Bearer {INSTALL_TOKEN}");
        let user_auth = format!("Bearer {USER_TOKEN}");
        // The install's code becomes a token for the GitHub user who installed.
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .and(body_string_contains("code=good-code"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "access_token": USER_TOKEN })),
            )
            .mount(&mock)
            .await;
        // That user can see our installation, not the foreign one.
        Mock::given(method("GET"))
            .and(path("/user/installations"))
            .and(header("Authorization", user_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 1,
                "installations": [{ "id": installation_id }]
            })))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/app/installations/{installation_id}")))
            .and(header_exists("Authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": installation_id,
                "account": { "login": login, "type": "Organization" }
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/app/installations/{installation_id}/access_tokens"
            )))
            .and(header_exists("Authorization"))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(serde_json::json!({ "token": INSTALL_TOKEN })),
            )
            .mount(&mock)
            .await;
        // The installation sees the organization's private repo...
        Mock::given(method("GET"))
            .and(path("/installation/repositories"))
            .and(header("Authorization", install_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 1,
                "repositories": [repo_json(&private_repo, true)]
            })))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/repos/{private_repo}")))
            .and(header("Authorization", install_auth.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(repo_json(&private_repo, true)))
            .mount(&mock)
            .await;
        // ...which the shared server token can't.
        Mock::given(method("GET"))
            .and(path(format!("/repos/{private_repo}")))
            .and(header(
                "Authorization",
                format!("Bearer {SHARED_TOKEN}").as_str(),
            ))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // The shared token's own account, which no organization may be shown.
        Mock::given(method("GET"))
            .and(path("/user/repos"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!([repo_json(&shared_repo, true)])),
            )
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial]; points GitHub calls at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
            std::env::set_var("GITHUB_WEB_BASE", "https://github.example");
            std::env::set_var(
                "GITHUB_OAUTH_TOKEN_URL",
                format!("{}/login/oauth/access_token", mock.uri()),
            );
            std::env::set_var("GITHUB_TOKEN", SHARED_TOKEN);
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("FRONTEND_URL", "https://app.example");
            std::env::set_var("GITHUB_APP_ID", "12345");
            std::env::set_var("GITHUB_APP_SLUG", "hadal-test");
            std::env::set_var(
                "GITHUB_APP_PRIVATE_KEY",
                test_private_key().replace('\n', "\\n"),
            );
            std::env::set_var("GITHUB_APP_CLIENT_ID", "Iv1.test");
            std::env::set_var("GITHUB_APP_CLIENT_SECRET", "app-secret");
        }

        let pool = test_pool().await;
        let org = insert_org(&pool, &format!("Acme {suffix}")).await;
        let other_org = insert_org(&pool, &format!("Other {suffix}")).await;
        let (owner, owner_auth) = org_user(&pool, org, "owner").await;
        let (member, member_auth) = org_user(&pool, org, "member").await;
        let (other_owner, other_auth) = org_user(&pool, other_org, "owner").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_app::github_app_status)
                .service(crate::github_app::github_app_install)
                .service(crate::github_app::github_app_disconnect)
                .service(crate::github_app::github_app_setup)
                .service(crate::github_proxy::github_proxy)
                .service(crate::github_proxy::github_importable_repos)
                .service(crate::github_proxy::visible_projects)
                .service(crate::workspace::handler::create_project),
        )
        .await;
        let get = |uri: String, auth: Option<String>| {
            let app = &app;
            async move {
                let mut req = actix_test::TestRequest::get().uri(&uri);
                if let Some(auth) = auth {
                    req = req.insert_header(("Authorization", auth));
                }
                actix_test::call_service(app, req.to_request()).await
            }
        };
        let json_of = |resp: actix_web::dev::ServiceResponse| async move {
            let body = actix_test::read_body(resp).await;
            serde_json::from_slice::<serde_json::Value>(&body)
                .unwrap_or_else(|e| panic!("json body: {e}"))
        };

        // Not connected: asked to connect, and never shown the server's repos.
        let importable =
            json_of(get("/github-importable-repos".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(importable["connected"], false);
        assert_eq!(importable["repos"], serde_json::json!([]));
        let visible =
            json_of(get("/projects/visible".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(
            visible["repos"],
            serde_json::json!([]),
            "shared token's repos leaked: {visible}"
        );

        // Only the owner can start the install; it goes to the App's page.
        let member_install = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/github-app/install")
                .insert_header(("Authorization", member_auth.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(member_install.status(), StatusCode::FORBIDDEN);
        let install = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/github-app/install")
                .insert_header(("Authorization", owner_auth.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(install.status(), StatusCode::OK);
        let install_url = json_of(install).await["url"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(
            install_url
                .starts_with("https://github.example/apps/hadal-test/installations/new?state="),
            "{install_url}"
        );
        let state = install_url
            .split("state=")
            .nth(1)
            .unwrap_or_default()
            .to_string();

        // Someone else's installation id is refused, and the state is spent.
        let foreign = get(
            format!("/github/oauth/app/setup?installation_id={foreign_installation}&setup_action=install&state={state}&code=good-code"),
            None,
        )
        .await;
        assert!(
            location(&foreign).ends_with("#github_app_error=not_your_installation"),
            "{}",
            location(&foreign)
        );
        let replay = get(
            format!("/github/oauth/app/setup?installation_id={installation_id}&setup_action=install&state={state}&code=good-code"),
            None,
        )
        .await;
        assert!(
            location(&replay).ends_with("#github_app_error=invalid_state"),
            "{}",
            location(&replay)
        );

        // A state started by a non-owner can't connect the organization.
        let member_state = wayve_security::oauth::create_oauth_state(
            Some(member),
            &format!("github_app_install:{org}"),
            &pool,
        )
        .await
        .unwrap_or_else(|e| panic!("state: {e}"));
        let not_owner = get(
            format!("/github/oauth/app/setup?installation_id={installation_id}&setup_action=install&state={member_state}&code=good-code"),
            None,
        )
        .await;
        assert!(
            location(&not_owner).ends_with("#github_app_error=not_owner"),
            "{}",
            location(&not_owner)
        );

        // The owner's install of their own installation connects.
        let state = wayve_security::oauth::create_oauth_state(
            Some(owner),
            &format!("github_app_install:{org}"),
            &pool,
        )
        .await
        .unwrap_or_else(|e| panic!("state: {e}"));
        let connected = get(
            format!("/github/oauth/app/setup?installation_id={installation_id}&setup_action=install&state={state}&code=good-code"),
            None,
        )
        .await;
        assert_eq!(
            location(&connected),
            "https://app.example/settings/repositories#github_app=connected"
        );
        let status =
            json_of(get("/github-app/status".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(status["connected"], true);
        assert_eq!(status["account_login"], login.as_str());
        assert!(
            status["manage_url"]
                .as_str()
                .unwrap_or_default()
                .contains("/settings/installations/")
        );
        // Members see the connection, not the GitHub settings link.
        let member_status =
            json_of(get("/github-app/status".into(), Some(member_auth.clone())).await).await;
        assert_eq!(member_status["connected"], true);
        assert!(member_status["manage_url"].is_null());

        // The same installation can't be claimed by a second organization.
        let other_state = wayve_security::oauth::create_oauth_state(
            Some(other_owner),
            &format!("github_app_install:{other_org}"),
            &pool,
        )
        .await
        .unwrap_or_else(|e| panic!("state: {e}"));
        let taken = get(
            format!("/github/oauth/app/setup?installation_id={installation_id}&setup_action=install&state={other_state}&code=good-code"),
            None,
        )
        .await;
        assert!(
            location(&taken).ends_with("#github_app_error=installation_in_use"),
            "{}",
            location(&taken)
        );

        // Connected: the import list is the installation's, private included.
        let importable =
            json_of(get("/github-importable-repos".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(importable["connected"], true);
        assert_eq!(importable["repos"][0]["full_name"], private_repo.as_str());

        // The private repo can now be added...
        let created = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/projects")
                .insert_header(("Authorization", owner_auth.clone()))
                .set_json(serde_json::json!({ "name": "secret", "repo_url": format!("https://github.com/{private_repo}") }))
                .to_request(),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED, "create project");
        // ...and read through the installation token.
        let read = get(
            format!("/github/repos/{private_repo}"),
            Some(owner_auth.clone()),
        )
        .await;
        assert_eq!(read.status(), StatusCode::OK);
        let visible =
            json_of(get("/projects/visible".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(visible["repos"][0]["full_name"], private_repo.as_str());
        assert_eq!(visible["repos"].as_array().map(Vec::len), Some(1));

        // The other organization can't add it: without its own connection the
        // repo is private to the shared token.
        let refused = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/projects")
                .insert_header(("Authorization", other_auth.clone()))
                .set_json(serde_json::json!({ "name": "secret", "repo_url": format!("https://github.com/{private_repo}") }))
                .to_request(),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

        // Disconnecting forgets the installation.
        let disconnect = actix_test::call_service(
            &app,
            actix_test::TestRequest::delete()
                .uri("/github-app/install")
                .insert_header(("Authorization", owner_auth.clone()))
                .to_request(),
        )
        .await;
        assert_eq!(disconnect.status(), StatusCode::OK);
        let status =
            json_of(get("/github-app/status".into(), Some(owner_auth.clone())).await).await;
        assert_eq!(status["connected"], false);
        // The cached private copy went with it: the shared token gets a 404.
        let read = get(
            format!("/github/repos/{private_repo}"),
            Some(owner_auth.clone()),
        )
        .await;
        assert_eq!(read.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[owner, member, other_owner], &[org, other_org]).await;
        // SAFETY: serialized via #[serial].
        unsafe {
            for key in [
                "GITHUB_API_BASE",
                "GITHUB_WEB_BASE",
                "GITHUB_OAUTH_TOKEN_URL",
                "GITHUB_TOKEN",
                "GITHUB_APP_ID",
                "GITHUB_APP_SLUG",
                "GITHUB_APP_PRIVATE_KEY",
                "GITHUB_APP_CLIENT_ID",
                "GITHUB_APP_CLIENT_SECRET",
            ] {
                std::env::remove_var(key);
            }
        }
    }
}
