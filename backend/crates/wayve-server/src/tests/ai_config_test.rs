// The enterprise-owner-controlled AI provider. These tests pin that only an
// enterprise org owner can configure it, that the API key is stored encrypted
// and never read back, that every member of the org resolves the owner's
// provider, that the SSRF guard rejects a private custom base_url, and that a
// fail-closed provider error never silently falls back to the platform default.
// The upstream provider (Anthropic) is mocked with wiremock via ANTHROPIC_API_BASE.
#[cfg(test)]
mod tests {
    use crate::ai;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::{decrypt, encrypt};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    async fn mount_anthropic_ok(mock: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "pong" }]
            })))
            .mount(mock)
            .await;
    }

    /// An upstream that always fails, for the fail-closed case.
    async fn mount_anthropic_500(mock: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "type": "error",
                "error": { "type": "api_error", "message": "boom" }
            })))
            .mount(mock)
            .await;
    }

    /// Makes the user the owner of an enterprise-tier org and returns its id.
    async fn make_enterprise(pool: &PgPool, user_id: i32) -> i32 {
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Ent Org {user_id}"))
        .bind(format!("ent-org-ai-{user_id}"))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create org: {e}"));
        sqlx::query(
            "UPDATE users SET organization_id = $1, account_type = 'organization_admin' WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach org: {e}"));
        let plan_id: i32 = sqlx::query_scalar("SELECT id FROM plans WHERE code = 'enterprise'")
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("enterprise plan id: {e}"));
        sqlx::query(
            "INSERT INTO subscriptions (organization_id, plan_id, status) VALUES ($1, $2, 'active')",
        )
        .bind(org_id)
        .bind(plan_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("subscription: {e}"));
        org_id
    }

    async fn add_member(pool: &PgPool, org_id: i32, role: &str) -> i32 {
        let email = random_email();
        let uid = insert_local_user(pool, &email, "password123").await;
        sqlx::query("UPDATE users SET organization_id = $1 WHERE id = $2")
            .bind(org_id)
            .bind(uid)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach member: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(uid)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("member row: {e}"));
        uid
    }

    /// Makes the user a platform owner. Both the account_type and the
    /// platform_members row are needed: `resolve_ai_for_user` reads the row.
    async fn make_platform_owner(pool: &PgPool, user_id: i32) {
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner')
             ON CONFLICT (user_id) DO UPDATE SET role = 'owner'",
        )
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("platform member: {e}"));
    }

    async fn cleanup(pool: &PgPool, org_id: i32) {
        let _ = sqlx::query("DELETE FROM organization_members WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gate_blocks_personal_admin_and_member() {
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::get_config)
                .service(ai::config_handler::put_config)
                .service(ai::config_handler::delete_config),
        )
        .await;

        let email = random_email();
        let personal = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(personal, &email));
        let req = actix_test::TestRequest::get()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let owner_email = random_email();
        let owner = insert_local_user(&pool, &owner_email, "password123").await;
        let org_id = make_enterprise(&pool, owner).await;

        for role in ["admin", "member"] {
            let uid = add_member(&pool, org_id, role).await;
            let email = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
                .bind(uid)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("email: {e}"));
            let bearer = format!("Bearer {}", jwt_for(uid, &email));
            let req = actix_test::TestRequest::get()
                .uri("/ai/config")
                .insert_header(("Authorization", bearer))
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::FORBIDDEN,
                "{role} must be forbidden"
            );
        }

        drop(app);
        cleanup(&pool, org_id).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(personal)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn owner_put_get_delete_key_encrypted() {
        let mock = MockServer::start().await;
        mount_anthropic_ok(&mock).await;
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        let org_id = make_enterprise(&pool, owner).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::get_config)
                .service(ai::config_handler::put_config)
                .service(ai::config_handler::delete_config),
        )
        .await;

        let req = actix_test::TestRequest::put()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "provider": "anthropic",
                "model": "claude-opus-4-8",
                "api_key": "sk-ant-secret"
            }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        // The key must be at rest only as ciphertext that decrypts back.
        let row = sqlx::query(
            "SELECT provider, api_key_iv, api_key_encrypted FROM org_ai_configs WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("config row: {e}"));
        assert_eq!(row.get::<String, _>("provider"), "anthropic");
        let iv: String = row.get("api_key_iv");
        let enc: String = row.get("api_key_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "sk-ant-secret");

        // A read returns the config status but never the key itself.
        let req = actix_test::TestRequest::get()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["config"]["configured"], serde_json::json!(true));
        assert_eq!(body["config"]["provider"], serde_json::json!("anthropic"));
        assert_eq!(body["config"]["has_key"], serde_json::json!(true));
        assert!(body["config"].get("api_key").is_none());
        assert!(body["config"].get("api_key_encrypted").is_none());
        assert!(body["providers"].is_array());

        // Deleting reverts the org to the platform default.
        let req = actix_test::TestRequest::delete()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM org_ai_configs WHERE organization_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
        assert_eq!(remaining, 0);

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
        }
        cleanup(&pool, org_id).await;
        drop(mock);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn member_resolves_owner_provider() {
        let mock = MockServer::start().await;
        mount_anthropic_ok(&mock).await;
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        let org_id = make_enterprise(&pool, owner).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::get_config)
                .service(ai::config_handler::put_config)
                .service(ai::config_handler::delete_config),
        )
        .await;

        let req = actix_test::TestRequest::put()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({
                "provider": "anthropic",
                "api_key": "sk-ant-secret"
            }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        let member = add_member(&pool, org_id, "member").await;
        let resolved = ai::provider::resolve_ai_for_user(&pool, member)
            .await
            .unwrap_or_else(|e| panic!("resolve: {e}"))
            .unwrap_or_else(|| panic!("member should resolve the org provider"));
        assert_eq!(resolved.provider, ai::provider::AiProvider::Anthropic);
        assert_eq!(resolved.api_key, "sk-ant-secret");
        // The owner pinned no model, so the provider default applies.
        assert_eq!(
            resolved.model,
            ai::provider::AiProvider::Anthropic.default_model()
        );

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
        }
        cleanup(&pool, org_id).await;
        drop(mock);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn ssrf_rejects_private_base_url() {
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            // The SSRF guard must not be relaxed for this test.
            std::env::remove_var("MCP_ALLOW_PRIVATE_HOSTS");
        }
        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        let org_id = make_enterprise(&pool, owner).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::get_config)
                .service(ai::config_handler::put_config)
                .service(ai::config_handler::delete_config),
        )
        .await;

        // The link-local cloud metadata endpoint is the canonical SSRF target.
        let req = actix_test::TestRequest::put()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({
                "provider": "openai_compatible",
                "base_url": "https://169.254.169.254/v1",
                "api_key": "sk-test"
            }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::BAD_REQUEST
        );

        drop(app);
        cleanup(&pool, org_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn fail_closed_chat_errors_without_fallback() {
        let mock = MockServer::start().await;
        mount_anthropic_500(&mock).await;
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
            // A usable platform key that fail-closed must refuse to fall back to.
            std::env::set_var("GEMINI_API_KEY", "platform-gemini-key");
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        let org_id = make_enterprise(&pool, owner).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));

        // The config is inserted directly because the upstream 500s, so a
        // validating write would reject it; this test is about runtime behavior.
        let (iv, enc) = encrypt("sk-ant-secret").unwrap_or_else(|e| panic!("encrypt: {e}"));
        sqlx::query(
            "INSERT INTO org_ai_configs
                (organization_id, provider, api_key_iv, api_key_encrypted, fail_closed, enabled)
             VALUES ($1, 'anthropic', $2, $3, TRUE, TRUE)",
        )
        .bind(org_id)
        .bind(&iv)
        .bind(&enc)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert config: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::handler::ai_chat),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri("/ai/chat")
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({ "messages": [{ "role": "user", "content": "hi" }] }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
            std::env::remove_var("GEMINI_API_KEY");
        }
        cleanup(&pool, org_id).await;
        drop(mock);
    }

    // A platform owner can configure the platform-team provider without an
    // enterprise tier, and only platform members resolve it: the config must
    // never leak into an org or personal account, which keep the env default.
    #[actix_web::test]
    #[serial_test::serial]
    async fn platform_owner_configures_and_only_platform_members_resolve() {
        let mock = MockServer::start().await;
        mount_anthropic_ok(&mock).await;
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
            std::env::set_var("GEMINI_API_KEY", "platform-gemini-key");
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        make_platform_owner(&pool, owner).await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::get_config)
                .service(ai::config_handler::put_config)
                .service(ai::config_handler::delete_config),
        )
        .await;

        let req = actix_test::TestRequest::put()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "provider": "anthropic",
                "api_key": "sk-plat-secret"
            }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        // The key must be at rest only as ciphertext in the platform singleton.
        let row = sqlx::query(
            "SELECT provider, api_key_iv, api_key_encrypted FROM platform_ai_config WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("platform config row: {e}"));
        assert_eq!(row.get::<String, _>("provider"), "anthropic");
        let iv: String = row.get("api_key_iv");
        let enc: String = row.get("api_key_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "sk-plat-secret");

        let resolved = ai::provider::resolve_ai_for_user(&pool, owner)
            .await
            .unwrap_or_else(|e| panic!("resolve owner: {e}"))
            .unwrap_or_else(|| panic!("platform owner should resolve a provider"));
        assert_eq!(resolved.provider, ai::provider::AiProvider::Anthropic);
        assert_eq!(resolved.api_key, "sk-plat-secret");

        // A personal user must fall back to the env default, never the
        // platform-team config.
        let outsider_email = random_email();
        let outsider = insert_local_user(&pool, &outsider_email, "password123").await;
        let outsider_ai = ai::provider::resolve_ai_for_user(&pool, outsider)
            .await
            .unwrap_or_else(|e| panic!("resolve outsider: {e}"))
            .unwrap_or_else(|| panic!("outsider should resolve the env default"));
        assert_eq!(outsider_ai.provider, ai::provider::AiProvider::Gemini);

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
            std::env::remove_var("GEMINI_API_KEY");
        }
        let _ = sqlx::query("DELETE FROM platform_ai_config WHERE id = 1")
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(owner)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2")
            .bind(owner)
            .bind(outsider)
            .execute(&pool)
            .await;
        drop(mock);
    }
}
