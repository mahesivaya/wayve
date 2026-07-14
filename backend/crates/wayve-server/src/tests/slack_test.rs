// The Slack integration end to end: the enterprise gate, connecting with a
// validated bot token that is encrypted at rest, linking a Slack channel to a
// fresh Wayve channel, and importing history into it as server-readable rows.
// Slack is mocked with wiremock via the `SLACK_API_BASE` indirection.
#[cfg(test)]
mod tests {
    use crate::integrations;
    use crate::integrations::slack::client::SlackClient;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::decrypt;
    use wiremock::matchers::{body_string, body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    /// Makes the user an owner of an enterprise-tier org, which is what the
    /// Slack feature gate requires. Returns the org id.
    async fn make_enterprise(pool: &PgPool, user_id: i32) -> i32 {
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Ent Org {user_id}"))
        .bind(format!("ent-org-{user_id}"))
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

    async fn cleanup(pool: &PgPool, user_id: i32, org_id: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        // channels/links/subscriptions cascade from the org.
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn enterprise_gate_blocks_non_enterprise() {
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
        }
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::slack::handler::get_connection)
                .service(integrations::slack::handler::connect)
                .service(integrations::slack::handler::disconnect)
                .service(integrations::slack::handler::link_channel)
                .service(integrations::slack::handler::import),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/integrations/slack/connection")
            .insert_header(("Authorization", bearer))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn connect_link_and_import() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/auth.test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true, "team": "Acme", "team_id": "T1"
            })))
            .mount(&mock)
            .await;
        // Slack returns history newest-first; the import must store it oldest-first.
        Mock::given(method("GET"))
            .and(path("/conversations.history"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true,
                "messages": [
                    { "type": "message", "user": "U2", "text": "second", "ts": "200.0" },
                    { "type": "message", "user": "U1", "text": "first", "ts": "100.0" }
                ]
            })))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/users.info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true, "user": { "real_name": "Alice" }
            })))
            .mount(&mock)
            .await;

        // SAFETY: this mutates process env, so the test is #[serial] (and CI
        // runs --test-threads=1) to keep it from racing other tests.
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("SLACK_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let org_id = make_enterprise(&pool, user_id).await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::slack::handler::get_connection)
                .service(integrations::slack::handler::connect)
                .service(integrations::slack::handler::disconnect)
                .service(integrations::slack::handler::link_channel)
                .service(integrations::slack::handler::import),
        )
        .await;

        // Connecting must leave the bot token encrypted at rest.
        let req = actix_test::TestRequest::put()
            .uri("/integrations/slack/connection")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "bot_token": "xoxb-test-token" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let row = sqlx::query(
            "SELECT bot_token_iv, bot_token_encrypted FROM slack_connections WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("connection row: {e}"));
        let iv: String = row.get("bot_token_iv");
        let enc: String = row.get("bot_token_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "xoxb-test-token");

        let req = actix_test::TestRequest::post()
            .uri("/integrations/slack/links")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "slack_channel_id": "C123",
                "slack_channel_name": "general"
            }))
            .to_request();
        let link: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let wayve_channel_id = link["wayve_channel_id"].as_i64().expect("wayve_channel_id") as i32;

        let req = actix_test::TestRequest::post()
            .uri("/integrations/slack/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 2);

        // Imported rows are server-readable rather than E2E envelopes.
        let rows = sqlx::query(
            "SELECT content_encrypted, content_iv FROM channel_messages
             WHERE channel_id = $1 ORDER BY id ASC",
        )
        .bind(wayve_channel_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|e| panic!("messages: {e}"));
        assert_eq!(rows.len(), 2);
        let first_iv: String = rows[0].get("content_iv");
        let first_enc: String = rows[0].get("content_encrypted");
        let first = decrypt(&first_iv, &first_enc).unwrap_or_default();
        assert_eq!(first, "[Slack · Alice] first");

        // A second import is incremental: nothing past the cursor is re-imported.
        let req = actix_test::TestRequest::post()
            .uri("/integrations/slack/import")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({}))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["imported"], 0);

        drop(app);
        unsafe {
            std::env::remove_var("SLACK_API_BASE");
        }
        cleanup(&pool, user_id, org_id).await;
    }

    // A bridged message must carry a `username` override so Slack attributes it
    // to the Wayve sender rather than the bot. The mock matches only when the
    // override is present, so dropping it makes the post fail.
    #[actix_web::test]
    #[serial_test::serial]
    async fn outbound_post_includes_sender_name() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat.postMessage"))
            .and(body_string_contains("username=Alice"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .expect(1)
            .mount(&mock)
            .await;

        unsafe {
            std::env::set_var("SLACK_API_BASE", mock.uri());
        }
        let res = SlackClient::from_token("xoxb-test")
            .post_message("C1", "hello", Some("Alice"))
            .await;
        assert!(res.is_ok(), "outbound post should succeed: {res:?}");

        unsafe {
            std::env::remove_var("SLACK_API_BASE");
        }
        // The `.expect(1)` above is verified on drop.
        drop(mock);
    }

    // A workspace without `chat:write.customize` rejects the customized post
    // with `missing_scope`, and the client must retry once as a plain bot post
    // so bridging never silently breaks.
    #[actix_web::test]
    #[serial_test::serial]
    async fn outbound_post_falls_back_without_customize_scope() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat.postMessage"))
            .and(body_string_contains("username="))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"ok": false, "error": "missing_scope"})),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/chat.postMessage"))
            .and(body_string("channel=C1&text=hello"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true})))
            .expect(1)
            .mount(&mock)
            .await;

        unsafe {
            std::env::set_var("SLACK_API_BASE", mock.uri());
        }
        let res = SlackClient::from_token("xoxb-test")
            .post_message("C1", "hello", Some("Alice"))
            .await;
        assert!(res.is_ok(), "should fall back to a plain post: {res:?}");

        unsafe {
            std::env::remove_var("SLACK_API_BASE");
        }
        // Both `.expect(1)`s are verified on drop: one customized attempt, one
        // plain retry.
        drop(mock);
    }
}
