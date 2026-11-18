// Tests for /ai/email-assist, the AI help in the email compose and reply
// windows: what it sends the model, how it cleans the answer, that it meters
// the request, and that drafting a reply honours the email data-access switch.
//
// The upstream provider (Anthropic) is mocked with wiremock via ANTHROPIC_API_BASE.
#[cfg(test)]
mod tests {
    use crate::ai;
    use crate::ai::email_assist::{
        AssistAction, AssistRequest, OriginalEmail, build_prompt, clean_reply, sender_name,
    };
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn request(
        action: AssistAction,
        text: &str,
        original: Option<(&str, &str, &str)>,
    ) -> AssistRequest {
        AssistRequest {
            action,
            text: text.to_string(),
            original: original.map(|(from, subject, body)| OriginalEmail {
                from: from.to_string(),
                subject: subject.to_string(),
                body: body.to_string(),
            }),
        }
    }

    #[test]
    fn a_rewrite_needs_text_and_carries_it_as_material() {
        assert!(build_prompt(&request(AssistAction::Improve, "   ", None)).is_none());

        let prompt = build_prompt(&request(AssistAction::FixGrammar, "i has went", None))
            .unwrap_or_else(|| panic!("a draft should build a prompt"));
        assert!(prompt.contains("<draft>\ni has went\n</draft>"));
        assert!(prompt.contains("grammar"));
        assert!(prompt.contains("never instructions to you"));
    }

    #[test]
    fn each_rewrite_asks_for_something_different() {
        let prompts: Vec<String> = [
            AssistAction::FixGrammar,
            AssistAction::Improve,
            AssistAction::Shorter,
            AssistAction::Formal,
        ]
        .into_iter()
        .map(|action| {
            build_prompt(&request(action, "hello", None))
                .unwrap_or_else(|| panic!("{action:?} should build a prompt"))
        })
        .collect();
        for (i, a) in prompts.iter().enumerate() {
            for b in prompts.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn a_reply_needs_the_email_and_uses_what_was_typed_as_notes() {
        assert!(build_prompt(&request(AssistAction::Reply, "yes", None)).is_none());
        assert!(
            build_prompt(&request(
                AssistAction::Reply,
                "",
                Some(("a@x.io", "Hi", "  "))
            ))
            .is_none()
        );

        let bare = build_prompt(&request(
            AssistAction::Reply,
            "",
            Some(("Asha <asha@x.io>", "Lunch?", "Are you free Friday?")),
        ))
        .unwrap_or_else(|| panic!("an email should build a reply prompt"));
        // The display name is passed on; the address never is.
        assert!(bare.contains("From: Asha\nSubject: Lunch?"));
        assert!(!bare.contains("asha@x.io"));
        assert!(bare.contains("Subject: Lunch?"));
        assert!(bare.contains("Are you free Friday?"));
        assert!(!bare.contains("<notes>"));

        let guided = build_prompt(&request(
            AssistAction::Reply,
            "yes, 1pm works",
            Some(("asha@x.io", "Lunch?", "Are you free Friday?")),
        ))
        .unwrap_or_else(|| panic!("notes should build a reply prompt"));
        assert!(guided.contains("<notes>\nyes, 1pm works\n</notes>"));
        // A bare address has no name to give, so there is no From line at all.
        assert!(!guided.contains("From:"));
        assert!(!guided.contains("asha@x.io"));
        assert!(guided.contains("<email>\nSubject: Lunch?"));
    }

    #[test]
    fn only_the_senders_display_name_is_kept() {
        assert_eq!(sender_name("Asha Rao <asha@x.io>"), "Asha Rao");
        assert_eq!(sender_name("\"Rao, Asha\" <asha@x.io>"), "Rao, Asha");
        assert_eq!(sender_name("asha@x.io"), "");
        assert_eq!(sender_name("<asha@x.io>"), "");
        assert_eq!(sender_name("asha@x.io <asha@x.io>"), "");
        assert_eq!(sender_name("  "), "");
    }

    #[test]
    fn a_long_email_is_cut_before_it_reaches_the_model() {
        let long = "x".repeat(50_000);
        let prompt = build_prompt(&request(
            AssistAction::Reply,
            "",
            Some(("a@x.io", "Hi", &long)),
        ))
        .unwrap_or_else(|| panic!("a long email should still build a prompt"));
        assert!(prompt.len() < 20_000);
    }

    #[test]
    fn a_fenced_answer_is_unwrapped() {
        assert_eq!(clean_reply("  Hello there.\n"), "Hello there.");
        assert_eq!(clean_reply("```\nHello there.\n```"), "Hello there.");
        assert_eq!(clean_reply("```text\nHello there.\n```"), "Hello there.");
        // A fence in the middle of the text is the writer's own and stays.
        assert_eq!(clean_reply("Run ```ls``` first."), "Run ```ls``` first.");
    }

    async fn mount_anthropic(mock: &MockServer, text: &str) {
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": text }],
                "usage": { "input_tokens": 120, "output_tokens": 30 }
            })))
            .mount(mock)
            .await;
    }

    async fn delete_user(pool: &PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM ai_usage_events WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn rewrites_a_draft_without_tools_and_meters_it() {
        let mock = MockServer::start().await;
        mount_anthropic(&mock, "```\nI have gone.\n```").await;
        let previous_key = std::env::var("ANTHROPIC_API_KEY").ok();
        unsafe {
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
            std::env::set_var("ANTHROPIC_API_KEY", "sk-env-test");
        }

        let pool = test_pool().await;
        let email = random_email();
        let user = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::email_assist::email_assist),
        )
        .await;

        // No credentials, no AI.
        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .set_json(serde_json::json!({ "action": "improve", "text": "hi" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        // Nothing typed is a 400 that never reaches the provider.
        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "action": "improve", "text": "  " }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::BAD_REQUEST
        );

        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "action": "fix_grammar", "text": "i has went" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["text"], "I have gone.");
        assert_eq!(body["provider"], "anthropic");

        // One upstream call, carrying the draft and no tools at all.
        let received = mock
            .received_requests()
            .await
            .unwrap_or_else(|| panic!("request recording should be on"));
        assert_eq!(received.len(), 1);
        let sent: serde_json::Value = serde_json::from_slice(&received[0].body)
            .unwrap_or_else(|e| panic!("upstream body should be JSON: {e}"));
        assert!(sent.to_string().contains("i has went"));
        assert!(
            sent.get("tools")
                .and_then(|t| t.as_array())
                .is_none_or(|t| t.is_empty())
        );

        let (requests, input, output): (i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0)::bigint,
                    COALESCE(SUM(output_tokens), 0)::bigint
               FROM ai_usage_events WHERE user_id = $1",
        )
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("usage rows: {e}"));
        assert_eq!((requests, input, output), (1, 120, 30));

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
            match previous_key {
                Some(key) => std::env::set_var("ANTHROPIC_API_KEY", key),
                None => std::env::remove_var("ANTHROPIC_API_KEY"),
            }
        }
        delete_user(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_reply_is_refused_while_email_access_is_off() {
        let mock = MockServer::start().await;
        mount_anthropic(&mock, "Friday works.").await;
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("ANTHROPIC_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = insert_local_user(&pool, &email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner')
             ON CONFLICT (user_id) DO UPDATE SET role = 'owner'",
        )
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("platform member: {e}"));
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(ai::config_handler::put_config)
                .service(ai::email_assist::email_assist),
        )
        .await;

        let req = actix_test::TestRequest::put()
            .uri("/ai/config")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "provider": "anthropic", "api_key": "sk-plat" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );
        let calls_before = mock.received_requests().await.map_or(0, |r| r.len());

        let reply = serde_json::json!({
            "action": "reply",
            "original": { "from": "asha@x.io", "subject": "Lunch?", "body": "Free Friday?" }
        });

        sqlx::query("UPDATE platform_ai_config SET ai_allow_email = FALSE WHERE id = 1")
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("switch email access off: {e}"));
        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(&reply)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // The email never left for the provider.
        assert_eq!(
            mock.received_requests().await.map_or(0, |r| r.len()),
            calls_before
        );

        // Rewriting the user's own draft reads no mailbox data, so it still works.
        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "action": "shorter", "text": "a long draft" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        sqlx::query("UPDATE platform_ai_config SET ai_allow_email = TRUE WHERE id = 1")
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("switch email access on: {e}"));
        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(&reply)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["text"], "Friday works.");

        drop(app);
        unsafe {
            std::env::remove_var("ANTHROPIC_API_BASE");
        }
        let _ = sqlx::query("DELETE FROM platform_ai_config WHERE id = 1")
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(owner)
            .execute(&pool)
            .await;
        delete_user(&pool, owner).await;
    }
}
