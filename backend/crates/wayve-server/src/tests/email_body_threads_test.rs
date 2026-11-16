// The body worker loads a conversation's pending bodies with one
// `threads.get?format=full` when two or more of them are waiting, keeps
// `messages.get` for a lone email, and falls back to `messages.get` for anything
// the conversation call didn't bring back.
#[cfg(test)]
mod tests {
    use crate::email::body_worker::{BodyJob, PendingBody, group_into_jobs, process_account};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use base64::Engine as _;
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use wayve_security::encryption::decrypt;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn pending(id: i32, thread: Option<&str>) -> PendingBody {
        PendingBody {
            id,
            gmail_id: format!("g{id}"),
            thread_id: thread.map(str::to_string),
        }
    }

    #[test]
    fn groups_conversations_with_several_pending_emails_into_one_job() {
        let jobs = group_into_jobs(vec![
            pending(9, Some("tA")),
            pending(8, Some("tB")),
            pending(7, None),
            pending(6, Some("tA")),
            pending(5, Some("tA")),
        ]);
        assert_eq!(
            jobs,
            vec![
                BodyJob::Thread {
                    thread_id: "tA".to_string(),
                    pending: vec![
                        pending(9, Some("tA")),
                        pending(6, Some("tA")),
                        pending(5, Some("tA")),
                    ],
                },
                BodyJob::Message(pending(8, Some("tB"))),
                BodyJob::Message(pending(7, None)),
            ]
        );
    }

    fn full_message(id: &str, text: &str) -> Value {
        let data = base64::engine::general_purpose::URL_SAFE.encode(text);
        json!({
            "id": id,
            "payload": { "mimeType": "text/plain", "body": { "data": data } },
        })
    }

    async fn mailbox(pool: &PgPool) -> (i32, i32) {
        let email = random_email();
        let user = insert_local_user(pool, &email, "Password123!").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(&email)
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, account)
    }

    /// A headers-only email, filed under Gmail conversation `thread` when given.
    async fn pending_email(pool: &PgPool, account: i32, gmail_id: &str, thread: Option<&str>) {
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, body_encrypted, attachments_checked) \
             VALUES ($1, $2, '', false) RETURNING id",
        )
        .bind(gmail_id)
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        if let Some(thread) = thread {
            sqlx::query(
                "INSERT INTO email_thread_meta (email_id, account_id, provider_thread_id) \
                 VALUES ($1, $2, $3)",
            )
            .bind(id)
            .bind(account)
            .bind(thread)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("thread meta: {e}"));
        }
    }

    async fn body(pool: &PgPool, account: i32, gmail_id: &str) -> String {
        let (iv, encrypted): (String, String) = sqlx::query_as(
            "SELECT body_iv, body_encrypted FROM emails WHERE account_id = $1 AND gmail_id = $2",
        )
        .bind(account)
        .bind(gmail_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("body: {e}"));
        decrypt(&iv, &encrypted).unwrap_or_else(|e| panic!("decrypt {gmail_id}: {e}"))
    }

    async fn mock_get(mock: &MockServer, url: &str, response: ResponseTemplate, calls: u64) {
        Mock::given(method("GET"))
            .and(path(url))
            .and(query_param("format", "full"))
            .respond_with(response)
            .expect(calls)
            .mount(mock)
            .await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fetches_a_conversations_pending_bodies_in_one_call() {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("AES_KEY", HEX64_TEST_KEY) };
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool).await;
        // x1 and x2 share conversation tX; x3 is in it too but the thread call
        // leaves it out. y1 is alone in tY; z1 has no recorded conversation.
        pending_email(&pool, account, "x1", Some("tX")).await;
        pending_email(&pool, account, "x2", Some("tX")).await;
        pending_email(&pool, account, "x3", Some("tX")).await;
        pending_email(&pool, account, "y1", Some("tY")).await;
        pending_email(&pool, account, "z1", None).await;

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "tok", "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        mock_get(
            &mock,
            "/gmail/v1/users/me/threads/tX",
            ResponseTemplate::new(200).set_body_json(json!({
                "id": "tX",
                "messages": [full_message("x1", "first"), full_message("x2", "second")],
            })),
            1,
        )
        .await;
        mock_get(
            &mock,
            "/gmail/v1/users/me/messages/x3",
            ResponseTemplate::new(200).set_body_json(full_message("x3", "third")),
            1,
        )
        .await;
        mock_get(
            &mock,
            "/gmail/v1/users/me/messages/y1",
            ResponseTemplate::new(200).set_body_json(full_message("y1", "alone")),
            1,
        )
        .await;
        mock_get(
            &mock,
            "/gmail/v1/users/me/messages/z1",
            ResponseTemplate::new(200).set_body_json(full_message("z1", "unthreaded")),
            1,
        )
        .await;
        for unexpected in [
            "/gmail/v1/users/me/messages/x1",
            "/gmail/v1/users/me/messages/x2",
            "/gmail/v1/users/me/threads/tY",
        ] {
            mock_get(&mock, unexpected, ResponseTemplate::new(500), 0).await;
        }

        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
            std::env::set_var("GOOGLE_TOKEN_URL", format!("{}/token", mock.uri()));
        }
        let stored = process_account(&pool, account, "id", "secret", "refresh").await;
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
            std::env::remove_var("GOOGLE_TOKEN_URL");
        }
        let stored = stored.unwrap_or_else(|e| panic!("process_account: {e}"));

        assert_eq!(stored, 5);
        for (gmail_id, text) in [
            ("x1", "first"),
            ("x2", "second"),
            ("x3", "third"),
            ("y1", "alone"),
            ("z1", "unthreaded"),
        ] {
            assert_eq!(body(&pool, account, gmail_id).await, text, "{gmail_id}");
        }
        mock.verify().await;

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn falls_back_to_one_call_per_message_when_the_conversation_fails() {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("AES_KEY", HEX64_TEST_KEY) };
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool).await;
        pending_email(&pool, account, "w1", Some("tW")).await;
        pending_email(&pool, account, "w2", Some("tW")).await;

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "tok", "expires_in": 3600
            })))
            .mount(&mock)
            .await;
        mock_get(
            &mock,
            "/gmail/v1/users/me/threads/tW",
            ResponseTemplate::new(500),
            1,
        )
        .await;
        for (id, text) in [("w1", "one"), ("w2", "two")] {
            mock_get(
                &mock,
                &format!("/gmail/v1/users/me/messages/{id}"),
                ResponseTemplate::new(200).set_body_json(full_message(id, text)),
                1,
            )
            .await;
        }

        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
            std::env::set_var("GOOGLE_TOKEN_URL", format!("{}/token", mock.uri()));
        }
        let stored = process_account(&pool, account, "id", "secret", "refresh").await;
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
            std::env::remove_var("GOOGLE_TOKEN_URL");
        }
        assert_eq!(stored.unwrap_or_else(|e| panic!("process_account: {e}")), 2);
        assert_eq!(body(&pool, account, "w1").await, "one");
        assert_eq!(body(&pool, account, "w2").await, "two");
        mock.verify().await;

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }
}
