#[cfg(test)]
mod ws_tests {
    use crate::call::handler::call_ws;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, web};
    use awc::ws as awsm;
    use futures_util::{SinkExt, StreamExt};
    use sqlx::PgPool;
    use std::time::Duration;

    /// Build a `?token=<jwt>` query string for `user_id`.
    fn token_query(user_id: i32) -> String {
        let jwt = jwt_for(user_id, &format!("ws-{user_id}@test.local"));
        format!("token={jwt}")
    }

    /// Spin up a real test server with `call_ws` + the DB pool the handler
    /// requires for RBAC scope resolution.
    fn start_call_server(pool: PgPool) -> actix_test::TestServer {
        actix_test::start(move || {
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .route("/ws/call", web::get().to(call_ws))
        })
    }

    /// Wait for the next text frame on `framed`, with a 2s timeout.
    macro_rules! next_text {
        ($framed:expr) => {{
            let timed = tokio::time::timeout(Duration::from_secs(2), $framed.next()).await;
            match timed {
                Ok(Some(Ok(awsm::Frame::Text(bytes)))) => {
                    Some(String::from_utf8(bytes.to_vec()).expect("utf8 text frame"))
                }
                _ => None,
            }
        }};
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_forwards_signal_between_two_clients() {
        let pool = test_pool().await;
        let id_a = insert_local_user(&pool, &random_email(), "p").await;
        let id_b = insert_local_user(&pool, &random_email(), "p").await;

        let srv = start_call_server(pool.clone());
        let url_a = srv.url(&format!("/ws/call?{}", token_query(id_a)));
        let url_b = srv.url(&format!("/ws/call?{}", token_query(id_b)));
        let (_, mut a) = awc::Client::default().ws(&url_a).connect().await.unwrap();
        let (_, mut b) = awc::Client::default().ws(&url_b).connect().await.unwrap();

        // Give B's `started` hook a tick to register in SESSIONS before A sends.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let signal = serde_json::json!({
            "type": "offer",
            "to": id_b,
            "from": null,
            "sdp": "v=0\r\no=- 1 1 IN IP4 0.0.0.0",
            "candidate": null,
        });
        a.send(awsm::Message::Text(signal.to_string().into()))
            .await
            .unwrap();

        let received = next_text!(b).expect("B got a frame");
        let v: serde_json::Value = serde_json::from_str(&received).unwrap();
        assert_eq!(v["type"], "offer");
        assert_eq!(v["to"], id_b);
        assert_eq!(v["from"], id_a, "server must stamp `from` with sender id");
        assert!(v["sdp"].as_str().unwrap_or("").contains("v=0"));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_forwards_ice_candidate() {
        let pool = test_pool().await;
        let id_a = insert_local_user(&pool, &random_email(), "p").await;
        let id_b = insert_local_user(&pool, &random_email(), "p").await;

        let srv = start_call_server(pool.clone());
        let url_a = srv.url(&format!("/ws/call?{}", token_query(id_a)));
        let url_b = srv.url(&format!("/ws/call?{}", token_query(id_b)));
        let (_, mut a) = awc::Client::default().ws(&url_a).connect().await.unwrap();
        let (_, mut b) = awc::Client::default().ws(&url_b).connect().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // IceCandidate is `#[serde(rename_all = "camelCase")]` so browsers
        // can send sdpMid / sdpMLineIndex unchanged. The signal MUST use
        // camelCase keys here too or serde silently drops the fields and
        // addIceCandidate fails at the peer ("Candidate missing values
        // for both sdpMid and sdpMLineIndex").
        let signal = serde_json::json!({
            "type": "ice",
            "to": id_b,
            "from": null,
            "sdp": null,
            "candidate": {
                "candidate": "candidate:1 1 udp 2122252543 192.0.2.1 60001 typ host",
                "sdpMid": "0",
                "sdpMLineIndex": 0
            }
        });
        a.send(awsm::Message::Text(signal.to_string().into()))
            .await
            .unwrap();

        let received = next_text!(b).expect("B got a frame");
        let v: serde_json::Value = serde_json::from_str(&received).unwrap();
        assert_eq!(v["type"], "ice");
        assert_eq!(v["from"], id_a);
        assert_eq!(v["candidate"]["sdpMid"], "0");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_silently_drops_signal_when_target_offline() {
        let pool = test_pool().await;
        let id_a = insert_local_user(&pool, &random_email(), "p").await;

        let srv = start_call_server(pool.clone());
        let url_a = srv.url(&format!("/ws/call?{}", token_query(id_a)));
        let (_, mut a) = awc::Client::default().ws(&url_a).connect().await.unwrap();

        let signal = serde_json::json!({
            "type": "offer",
            "to": 999_999_999,  // user_id that doesn't exist; sender should get no echo
            "from": null,
            "sdp": "v=0",
            "candidate": null,
        });
        a.send(awsm::Message::Text(signal.to_string().into()))
            .await
            .unwrap();

        let res = tokio::time::timeout(Duration::from_millis(200), a.next()).await;
        assert!(
            res.is_err(),
            "sender must not receive an echo when target is offline"
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_ignores_non_json_text_and_keeps_session_open() {
        let pool = test_pool().await;
        let id_a = insert_local_user(&pool, &random_email(), "p").await;
        let id_b = insert_local_user(&pool, &random_email(), "p").await;

        let srv = start_call_server(pool.clone());
        let url_a = srv.url(&format!("/ws/call?{}", token_query(id_a)));
        let url_b = srv.url(&format!("/ws/call?{}", token_query(id_b)));
        let (_, mut a) = awc::Client::default().ws(&url_a).connect().await.unwrap();
        let (_, mut b) = awc::Client::default().ws(&url_b).connect().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // First send: garbage non-JSON. The handler must shrug and stay
        // connected.
        a.send(awsm::Message::Text("not json at all".into()))
            .await
            .unwrap();

        // Second send: a valid signal. It must arrive — proving the session
        // survived the bad frame.
        let signal = serde_json::json!({
            "type": "answer",
            "to": id_b,
            "from": null,
            "sdp": "v=0",
            "candidate": null,
        });
        a.send(awsm::Message::Text(signal.to_string().into()))
            .await
            .unwrap();

        let received = next_text!(b).expect("B got the answer signal");
        let v: serde_json::Value = serde_json::from_str(&received).unwrap();
        assert_eq!(v["type"], "answer");
    }

    // ----- Auth regression tests -----
    //
    // These two don't need DB users — the handler should reject at the
    // JWT validation step, before any RBAC lookup. The pool is attached
    // anyway because Actix's extractor system needs the type to resolve.

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_rejects_connection_without_token() {
        let pool = test_pool().await;
        let srv = start_call_server(pool);

        let url = srv.url("/ws/call");
        let res = awc::Client::default().ws(&url).connect().await;
        match res {
            Ok(_) => panic!("expected handshake to fail (401), but it upgraded"),
            Err(e) => {
                let msg = format!("{e:?}");
                assert!(
                    msg.contains("401")
                        || msg.contains("Unauthorized")
                        || msg.contains("InvalidResponseStatus"),
                    "expected 401-shaped error, got: {msg}"
                );
            }
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_rejects_invalid_token() {
        let pool = test_pool().await;
        let srv = start_call_server(pool);

        let url = srv.url("/ws/call?token=not-a-real-jwt");
        let res = awc::Client::default().ws(&url).connect().await;
        match res {
            Ok(_) => panic!("expected handshake to fail (401), but it upgraded"),
            Err(e) => {
                let msg = format!("{e:?}");
                assert!(
                    msg.contains("401")
                        || msg.contains("Unauthorized")
                        || msg.contains("InvalidResponseStatus"),
                    "expected 401-shaped error, got: {msg}"
                );
            }
        }
    }

    /// SECURITY REGRESSION: ensures user_id comes from the JWT, never from a
    /// query string. Without this, an attacker could pass `?user_id=<victim>`
    /// and impersonate another user. Test mounts attacker as id_a (per JWT)
    /// while passing `&user_id=<victim>` in the URL. The signal should be
    /// stamped with id_a (the JWT subject), not the victim id.
    #[actix_web::test]
    #[serial_test::serial]
    async fn call_ws_user_id_comes_from_jwt_not_query_param() {
        let pool = test_pool().await;
        let id_a = insert_local_user(&pool, &random_email(), "p").await;
        let id_b = insert_local_user(&pool, &random_email(), "p").await;
        let victim = insert_local_user(&pool, &random_email(), "p").await;

        let srv = start_call_server(pool.clone());

        // Attacker A connects with their own JWT but tries to spoof
        // user_id=victim via the legacy query parameter.
        let url_a = srv.url(&format!(
            "/ws/call?{}&user_id={}",
            token_query(id_a),
            victim
        ));
        let url_b = srv.url(&format!("/ws/call?{}", token_query(id_b)));
        let (_, mut a) = awc::Client::default().ws(&url_a).connect().await.unwrap();
        let (_, mut b) = awc::Client::default().ws(&url_b).connect().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        a.send(awsm::Message::Text(
            serde_json::json!({
                "type": "offer",
                "to": id_b,
                "from": null,
                "sdp": "v=0",
                "candidate": null,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        let received = next_text!(b).expect("B got the signal");
        let v: serde_json::Value = serde_json::from_str(&received).unwrap();
        assert_eq!(
            v["from"], id_a,
            "from must come from JWT claims, NEVER from spoofed user_id query param"
        );
        assert_ne!(
            v["from"], victim,
            "spoofed user_id query param must be ignored"
        );
    }
}
