// Forwarding an email carries its attachments: the send request names the
// stored attachments and the server fetches each file from the provider. Only
// the caller's own attachments, every file or none, and within the send limits.
#[cfg(test)]
mod tests {
    use crate::email::account::seal_token;
    use crate::email::attachments::{
        ForwardAttachmentError, fetch_for_forward, fetch_gmail_attachment_bytes,
    };
    use crate::models::email_request::SendEmailRequest;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct Mailbox {
        user: i32,
        user_email: String,
        account: i32,
    }

    async fn mailbox(pool: &PgPool, refresh_token: &str) -> Mailbox {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
        let (iv, ciphertext) =
            seal_token(refresh_token).unwrap_or_else(|e| panic!("seal refresh token: {e}"));
        let user_email = random_email();
        let user = insert_local_user(pool, &user_email, "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts \
               (email, user_id, provider, refresh_token_iv, refresh_token_encrypted) \
             VALUES ($1, $2, 'google', $3, $4) RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .bind(iv)
        .bind(ciphertext)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        Mailbox {
            user,
            user_email,
            account,
        }
    }

    // An email in `account` with one stored attachment; returns the attachment id.
    async fn attachment(pool: &PgPool, account: i32) -> i32 {
        let email: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels) \
             VALUES ($1, $2, 'ann@x.com', '{INBOX}') RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        sqlx::query_scalar(
            "INSERT INTO email_attachments (email_id, account_id, gmail_id, attachment_id, filename, mime_type, size) \
             VALUES ($1, $2, 'msg1', 'att1', 'report.pdf', 'application/pdf', 3) RETURNING id",
        )
        .bind(email)
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("attachment: {e}"))
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
    async fn fetches_a_gmail_attachments_bytes() {
        let mock = MockServer::start().await;
        // Gmail sends base64url, sometimes padded.
        for (id, data) in [("plain", "aGVsbG8"), ("padded", "aGVsbG8=")] {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/gmail/v1/users/me/messages/msg1/attachments/{id}"
                )))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": data })),
                )
                .mount(&mock)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/msg1/attachments/gone"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };

        let plain = fetch_gmail_attachment_bytes("tok", "msg1", "plain").await;
        let padded = fetch_gmail_attachment_bytes("tok", "msg1", "padded").await;
        let gone = fetch_gmail_attachment_bytes("tok", "msg1", "gone").await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        assert_eq!(plain.unwrap_or_else(|e| panic!("plain: {e}")), b"hello");
        assert_eq!(padded.unwrap_or_else(|e| panic!("padded: {e}")), b"hello");
        // A missing attachment is an error, not an empty file.
        assert!(gone.is_err());
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn only_your_own_attachments_and_only_with_a_sign_in() {
        let pool = test_pool().await;
        let me = mailbox(&pool, "").await;
        let stranger = mailbox(&pool, "tok").await;
        let mine = attachment(&pool, me.account).await;
        let theirs = attachment(&pool, stranger.account).await;

        // Someone else's attachment is not found, with nothing fetched.
        let other = fetch_for_forward(&pool, me.user, &[theirs]).await;
        assert!(matches!(other, Err(ForwardAttachmentError::NotFound)));
        // One bad id fails the whole forward.
        let mixed = fetch_for_forward(&pool, me.user, &[mine, theirs]).await;
        assert!(matches!(mixed, Err(ForwardAttachmentError::NotFound)));
        // Your own, from a mailbox with no sign-in: reconnect first.
        let own = fetch_for_forward(&pool, me.user, &[mine]).await;
        assert!(matches!(own, Err(ForwardAttachmentError::Reconnect)));

        cleanup(&pool, &[me.user, stranger.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn too_many_attachments_are_refused_before_anything_is_fetched() {
        let pool = test_pool().await;
        let me = mailbox(&pool, "tok").await;
        let mut ids = Vec::new();
        for _ in 0..11 {
            ids.push(attachment(&pool, me.account).await);
        }
        let req = actix_test::TestRequest::post()
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(me.user, &me.user_email)),
            ))
            .to_http_request();
        let data = SendEmailRequest {
            account_id: me.account,
            to: "bob@example.com".into(),
            subject: "Fwd: report".into(),
            body: "fyi".into(),
            cc: vec![],
            bcc: vec![],
            attachments: vec![],
            forward_attachment_ids: ids,
            reply_to_email_id: None,
            reply_headers: None,
        };

        // No Gmail is configured here, so reaching the provider would fail
        // differently (502): 413 proves the count is checked first.
        let resp = crate::email::send::send(req, web::Json(data), web::Data::new(pool.clone()))
            .await
            .unwrap_or_else(|e| panic!("send: {e:?}"));
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

        cleanup(&pool, &[me.user]).await;
    }
}
