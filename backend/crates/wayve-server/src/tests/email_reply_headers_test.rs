// Threaded replies on the send side. A reply names the email it answers; the
// server looks that email up in the sending mailbox only, and writes validated
// In-Reply-To / References (and Gmail's threadId) onto the outgoing message.
// Header values that came from incoming mail can't inject headers, and a
// rejected Gmail threadId never stops the reply from going out.
#[cfg(test)]
mod tests {
    use crate::email::reply_headers::{self, ReplyHeaders};
    use crate::models::email_request::SendEmailRequest;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use base64::Engine as _;
    use sqlx::PgPool;
    use wayve_security::encryption::encrypt;
    use wiremock::matchers::{body_partial_json, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ensure_aes_key() {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

    /// A user and their Gmail mailbox. The `fake-` refresh token routes the
    /// send handler's dev shortcut through local SMTP (Mailpit).
    async fn owner_mailbox(pool: &PgPool) -> (i32, String, i32) {
        let email = random_email();
        let user = insert_local_user(pool, &email, "password123").await;
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, refresh_token) \
             VALUES ($1, $2, 'google', 'fake-reply-test') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, email, account)
    }

    /// A synced email with the threading metadata sync would have stored:
    /// message id and references encrypted, ids without angle brackets.
    async fn original(
        pool: &PgPool,
        account: i32,
        message_id: &str,
        references: &str,
        thread_id: &str,
    ) -> i32 {
        let email_id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, created_at) \
             VALUES ($1, $2, NOW()) RETURNING id",
        )
        .bind(format!("orig-{}", random_email()))
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        let (id_iv, id_ct) = encrypt(message_id).unwrap_or_else(|e| panic!("encrypt: {e}"));
        let (ref_iv, ref_ct) = encrypt(references).unwrap_or_else(|e| panic!("encrypt: {e}"));
        sqlx::query(
            "INSERT INTO email_thread_meta \
             (email_id, account_id, message_id_iv, message_id_encrypted, \
              references_iv, references_encrypted, provider_thread_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(email_id)
        .bind(account)
        .bind(id_iv)
        .bind(id_ct)
        .bind(ref_iv)
        .bind(ref_ct)
        .bind(thread_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("thread meta: {e}"));
        email_id
    }

    async fn cleanup(pool: &PgPool, users: &[i32]) {
        for id in users {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reply_headers_come_only_from_the_senders_own_mailbox() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (owner, _, account) = owner_mailbox(&pool).await;
        let (stranger, _, stranger_account) = owner_mailbox(&pool).await;
        let email_id = original(
            &pool,
            account,
            "orig@x.com",
            "root@x.com orig@x.com",
            "19f7c7d35b08fe0c",
        )
        .await;

        let headers = reply_headers::load(&pool, owner, account, email_id).await;
        assert_eq!(
            headers,
            Some(ReplyHeaders {
                in_reply_to: "<orig@x.com>".into(),
                references: "<root@x.com> <orig@x.com>".into(),
                gmail_thread_id: Some("19f7c7d35b08fe0c".into()),
            })
        );

        // Another user, from their own mailbox, can't read it by id...
        assert_eq!(
            reply_headers::load(&pool, stranger, stranger_account, email_id).await,
            None
        );
        // ...nor by naming the owner's mailbox (row-level security).
        assert_eq!(
            reply_headers::load(&pool, stranger, account, email_id).await,
            None
        );
        // And the owner gets nothing when sending from a different mailbox.
        assert_eq!(
            reply_headers::load(&pool, owner, stranger_account, email_id).await,
            None
        );

        cleanup(&pool, &[owner, stranger]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_stored_message_id_with_a_line_break_is_dropped_not_sent() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (owner, _, account) = owner_mailbox(&pool).await;
        let email_id = original(&pool, account, "evil\r\nBcc: attacker@evil.test", "", "t1").await;

        assert_eq!(
            reply_headers::load(&pool, owner, account, email_id).await,
            None
        );

        cleanup(&pool, &[owner]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gmail_reply_carries_headers_and_survives_a_rejected_thread_id() {
        let mock = MockServer::start().await;
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("GMAIL_SEND_URL", format!("{}/send", mock.uri())) };
        Mock::given(method("POST"))
            .and(body_partial_json(serde_json::json!({ "threadId": "gone" })))
            .respond_with(ResponseTemplate::new(404))
            .with_priority(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .with_priority(2)
            .mount(&mock)
            .await;

        let data = SendEmailRequest {
            account_id: 1,
            to: "bob@example.com".into(),
            subject: "Re: hi".into(),
            body: "reply".into(),
            cc: vec![],
            bcc: vec![],
            attachments: vec![],
            forward_attachment_ids: vec![],
            reply_to_email_id: Some(1),
            reply_headers: Some(ReplyHeaders {
                in_reply_to: "<orig@x.com>".into(),
                references: "<root@x.com> <orig@x.com>".into(),
                gmail_thread_id: Some("gone".into()),
            }),
        };
        let resp = crate::email::send::send_via_gmail("token", "me@x.com", &data, 1).await;
        unsafe { std::env::remove_var("GMAIL_SEND_URL") };
        assert_eq!(resp.status(), StatusCode::OK, "the reply must still go out");

        let requests = mock.received_requests().await.unwrap_or_default();
        assert_eq!(
            requests.len(),
            2,
            "rejected once with threadId, then resent"
        );
        let bodies: Vec<serde_json::Value> = requests
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap_or_default())
            .collect();
        assert_eq!(bodies[0]["threadId"], "gone");
        assert!(bodies[1].get("threadId").is_none());
        let raw = base64::engine::general_purpose::URL_SAFE
            .decode(bodies[1]["raw"].as_str().unwrap_or_default())
            .unwrap_or_default();
        let raw = String::from_utf8_lossy(&raw);
        assert!(raw.contains("In-Reply-To: <orig@x.com>\r\n"), "{raw}");
        assert!(
            raw.contains("References: <root@x.com> <orig@x.com>\r\n"),
            "{raw}"
        );
    }

    /// The whole send handler, delivered for real through Mailpit: the reply is
    /// threaded, and a line break smuggled into the subject (as a reply's
    /// prefilled subject could carry) does not create a header. Skips itself
    /// when Mailpit is unconfigured (CI sets it; see smoke.yml).
    #[actix_web::test]
    #[serial_test::serial]
    async fn a_reply_is_threaded_and_header_injection_is_neutralised_end_to_end() {
        let (Ok(smtp_host), Ok(api)) = (
            std::env::var("MAILPIT_SMTP_HOST"),
            std::env::var("MAILPIT_API"),
        ) else {
            eprintln!("skipping: MAILPIT_SMTP_HOST / MAILPIT_API unset");
            return;
        };
        let smtp_port = std::env::var("MAILPIT_SMTP_PORT").unwrap_or_else(|_| "1025".to_string());
        ensure_aes_key();
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            std::env::set_var("SMTP_HOST", &smtp_host);
            std::env::set_var("SMTP_PORT", &smtp_port);
            std::env::set_var("SMTP_USER", "test@fluxze.com");
            std::env::set_var("SMTP_PASS", "test");
            std::env::set_var("SMTP_FROM", "no-reply@fluxze.com");
        }
        let pool = test_pool().await;
        let (owner, owner_email, account) = owner_mailbox(&pool).await;
        let email_id = original(&pool, account, "orig@x.com", "root@x.com", "t1").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .route("/emails", web::post().to(crate::email::handler::send)),
        )
        .await;
        let to = random_email();
        let attacker = random_email();
        let req = actix_test::TestRequest::post()
            .uri("/emails")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(owner, &owner_email)),
            ))
            .set_json(serde_json::json!({
                "account_id": account,
                "to": to,
                "subject": format!("Re: hi\r\nBcc: {attacker}"),
                "body": "threaded reply",
                "reply_to_email_id": email_id,
            }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let client = reqwest::Client::new();
        let search = |q: String| {
            let client = client.clone();
            let api = api.clone();
            async move {
                client
                    .get(format!("{api}/api/v1/search"))
                    .query(&[("query", q)])
                    .send()
                    .await
                    .unwrap_or_else(|e| panic!("mailpit search: {e}"))
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|e| panic!("mailpit json: {e}"))
            }
        };

        let found = search(format!("to:{to}")).await;
        let id = found["messages"][0]["ID"]
            .as_str()
            .unwrap_or_else(|| panic!("reply not delivered: {found}"))
            .to_string();
        let headers: serde_json::Value = client
            .get(format!("{api}/api/v1/message/{id}/headers"))
            .send()
            .await
            .unwrap_or_else(|e| panic!("mailpit headers: {e}"))
            .json()
            .await
            .unwrap_or_else(|e| panic!("mailpit headers json: {e}"));
        assert_eq!(headers["In-Reply-To"][0], "<orig@x.com>");
        assert_eq!(headers["References"][0], "<root@x.com> <orig@x.com>");
        assert!(headers.get("Bcc").is_none(), "no forged Bcc header");

        // The smuggled address received nothing.
        let leaked = search(format!("to:{attacker}")).await;
        assert_eq!(leaked["messages_count"], 0, "{leaked}");

        cleanup(&pool, &[owner]).await;
    }
}
