// Slack Events webhook end-to-end: signature verification, the url_verification
// handshake, a real message event landing in the linked Wayve channel
// (server-readable), echo-loop prevention (bot messages skipped), and the
// secret-unset 503. users.info is mocked via wiremock + SLACK_API_BASE.
#[cfg(test)]
mod tests {
    use crate::integrations::slack;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::{PgPool, Row};
    use std::time::Duration;
    use wayve_security::encryption::{decrypt, encrypt};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    type HmacSha256 = Hmac<Sha256>;

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const SIGNING_SECRET: &str = "test-slack-signing-secret";

    /// Sign a body exactly as Slack does: HMAC-SHA256 over `v0:{ts}:{body}`.
    fn sign(ts: &str, body: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(SIGNING_SECRET.as_bytes()).unwrap();
        mac.update(format!("v0:{ts}:{body}").as_bytes());
        let hex: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("v0={hex}")
    }

    fn now_ts() -> String {
        chrono::Utc::now().timestamp().to_string()
    }

    /// Seed an enterprise org with a connected Slack workspace (team `T1`) and a
    /// channel link `C1` → a fresh Wayve channel. Returns the Wayve channel id.
    async fn seed(pool: &PgPool, user_id: i32) -> i32 {
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Org {user_id}"))
        .bind(format!("org-{user_id}"))
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET organization_id = $1 WHERE id = $2")
            .bind(org_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();

        let channel_id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility)
             VALUES ('slack-import', $1, 'private') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'admin')",
        )
        .bind(channel_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();

        let (iv, enc) = encrypt("xoxb-test-token").unwrap();
        sqlx::query(
            "INSERT INTO slack_connections
                (organization_id, bot_token_iv, bot_token_encrypted, team_id, team_name, connected_by, enabled)
             VALUES ($1, $2, $3, 'T1', 'Acme', $4, TRUE)",
        )
        .bind(org_id)
        .bind(&iv)
        .bind(&enc)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO slack_channel_links
                (organization_id, wayve_channel_id, slack_channel_id, slack_channel_name)
             VALUES ($1, $2, 'C1', 'general')",
        )
        .bind(org_id)
        .bind(channel_id)
        .execute(pool)
        .await
        .unwrap();
        channel_id
    }

    async fn count_messages(pool: &PgPool, channel_id: i32) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM channel_messages WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn verify_handshake_and_message_flow() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users.info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true, "user": { "real_name": "Alice" }
            })))
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("SLACK_SIGNING_SECRET", SIGNING_SECRET);
            std::env::set_var("SLACK_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        let channel_id = seed(&pool, user_id).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<crate::cache::Cache>))
                .service(slack::webhook::slack_events),
        )
        .await;

        // 1. url_verification → echo the challenge.
        let body = r#"{"type":"url_verification","challenge":"chal-123"}"#;
        let ts = now_ts();
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/slack_events")
            .insert_header(("x-slack-request-timestamp", ts.clone()))
            .insert_header(("x-slack-signature", sign(&ts, body)))
            .insert_header(("content-type", "application/json"))
            .set_payload(body)
            .to_request();
        let resp: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["challenge"], "chal-123");

        // 2. A real message event → stored server-readable in the linked channel.
        let body = r#"{"type":"event_callback","team_id":"T1","event":{"type":"message","channel":"C1","user":"U1","text":"hello from slack"}}"#;
        let ts = now_ts();
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/slack_events")
            .insert_header(("x-slack-request-timestamp", ts.clone()))
            .insert_header(("x-slack-signature", sign(&ts, body)))
            .insert_header(("content-type", "application/json"))
            .set_payload(body)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // apply_event runs in a spawned task — poll for the row.
        let mut stored = None;
        for _ in 0..40 {
            let rows = sqlx::query(
                "SELECT content_encrypted, content_iv FROM channel_messages WHERE channel_id = $1",
            )
            .bind(channel_id)
            .fetch_all(&pool)
            .await
            .unwrap();
            if let Some(r) = rows.first() {
                stored = Some((
                    r.get::<String, _>("content_iv"),
                    r.get::<String, _>("content_encrypted"),
                ));
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let (iv, enc) = stored.expect("slack message stored");
        assert_eq!(
            decrypt(&iv, &enc).unwrap(),
            "[Slack · Alice] hello from slack"
        );
        assert_eq!(count_messages(&pool, channel_id).await, 1);

        // 3. A bot message (echo of our own outbound post) → skipped, no new row.
        let body = r#"{"type":"event_callback","team_id":"T1","event":{"type":"message","channel":"C1","bot_id":"B1","text":"echo"}}"#;
        let ts = now_ts();
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/slack_events")
            .insert_header(("x-slack-request-timestamp", ts.clone()))
            .insert_header(("x-slack-signature", sign(&ts, body)))
            .insert_header(("content-type", "application/json"))
            .set_payload(body)
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(count_messages(&pool, channel_id).await, 1);

        // 4. A tampered signature → 401.
        let req = actix_test::TestRequest::post()
            .uri("/webhooks/slack_events")
            .insert_header(("x-slack-request-timestamp", now_ts()))
            .insert_header(("x-slack-signature", "v0=deadbeef"))
            .insert_header(("content-type", "application/json"))
            .set_payload(body)
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        unsafe {
            std::env::remove_var("SLACK_API_BASE");
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn refuses_when_secret_unset() {
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::remove_var("SLACK_SIGNING_SECRET");
        }
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<crate::cache::Cache>))
                .service(slack::webhook::slack_events),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri("/webhooks/slack_events")
            .insert_header(("content-type", "application/json"))
            .set_payload(r#"{"type":"url_verification","challenge":"x"}"#)
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
