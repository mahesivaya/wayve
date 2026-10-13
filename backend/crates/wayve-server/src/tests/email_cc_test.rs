// The Cc header behind Reply all (email/repo.rs, email/cc_backfill.rs) against a
// real Postgres: sync stores it encrypted and the detail read returns it, an
// upsert that doesn't know the Cc keeps the stored one, Gmail's Cc headers are
// read case-insensitively and joined, and the backfill fills in older Gmail mail
// via a mocked API, recording deleted messages and ids Gmail rejects as invalid
// as having no Cc, and leaving refused ones (rate limits, a mailbox-wide 400)
// unknown for a later tick.
#[cfg(test)]
mod tests {
    use crate::email::cc_backfill::backfill_batch;
    use crate::email::provider::MailProvider;
    use crate::email::repo::{InsertEmail, get_detail, upsert_batch};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ensure_aes_key() {
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

    /// A Gmail mailbox and its owner.
    async fn mailbox(pool: &PgPool) -> (i32, i32) {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, account)
    }

    fn row<'a>(gmail_id: &'a str, cc: Option<&'a str>, labels: &'a [String]) -> InsertEmail<'a> {
        InsertEmail {
            gmail_id,
            sender: "ada@x.com",
            receiver: "me@x.com, bob@x.com",
            cc,
            subject: "Plans",
            created_at: Utc::now().naive_utc(),
            is_read: false,
            labels,
            body: None,
            attachments_checked: false,
        }
    }

    /// A Gmail API error body.
    fn gmail_error(message: &str, reason: &str, status: &str) -> serde_json::Value {
        serde_json::json!({ "error": {
            "code": 400,
            "message": message,
            "errors": [{ "message": message, "domain": "global", "reason": reason }],
            "status": status
        }})
    }

    async fn cc_of(pool: &PgPool, email_id: i32, user: i32) -> Option<String> {
        get_detail(pool, email_id, user)
            .await
            .unwrap_or_else(|e| panic!("detail: {e}"))
            .unwrap_or_else(|| panic!("email {email_id} not visible"))
            .cc
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn sync_stores_the_cc_and_an_unknown_cc_keeps_it() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (user, acct) = mailbox(&pool).await;
        let labels = vec!["INBOX".to_string()];

        let id = upsert_batch(
            &pool,
            acct,
            &[row("m1", Some("Carol <carol@x.com>, dan@x.com"), &labels)],
        )
        .await
        .unwrap_or_else(|e| panic!("upsert: {e}"))[0]
            .id;
        assert_eq!(
            cc_of(&pool, id, user).await.as_deref(),
            Some("Carol <carol@x.com>, dan@x.com")
        );
        let stored: Option<String> =
            sqlx::query_scalar("SELECT cc_encrypted FROM emails WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("raw: {e}"));
        assert!(
            !stored.unwrap_or_default().contains("carol"),
            "the Cc is stored encrypted"
        );

        // A re-sync that didn't read the Cc leaves it alone.
        upsert_batch(&pool, acct, &[row("m1", None, &labels)])
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(
            cc_of(&pool, id, user).await.as_deref(),
            Some("Carol <carol@x.com>, dan@x.com")
        );

        // One that read it and found none records that.
        upsert_batch(&pool, acct, &[row("m1", Some(""), &labels)])
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(cc_of(&pool, id, user).await.as_deref(), Some(""));
    }

    #[test]
    fn gmail_cc_headers_are_joined_case_insensitively() {
        let res = serde_json::json!({ "payload": { "headers": [
            { "name": "From", "value": "ada@x.com" },
            { "name": "Cc", "value": "carol@x.com" },
            { "name": "CC", "value": " \"Lee, Dan\" <dan@x.com> " }
        ]}});
        assert_eq!(
            crate::email::sync::extract_cc(&res),
            "carol@x.com, \"Lee, Dan\" <dan@x.com>"
        );
        let none = serde_json::json!({ "payload": { "headers": [
            { "name": "From", "value": "ada@x.com" }
        ]}});
        assert_eq!(crate::email::sync::extract_cc(&none), "");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn backfill_fills_older_gmail_mail_and_leaves_refused_ones_unknown() {
        ensure_aes_key();
        let mock = MockServer::start().await;
        let with_cc = |cc: Option<&str>| {
            let mut headers = vec![serde_json::json!({ "name": "From", "value": "ada@x.com" })];
            if let Some(cc) = cc {
                headers.push(serde_json::json!({ "name": "Cc", "value": cc }));
            }
            serde_json::json!({ "id": "x", "payload": { "headers": headers } })
        };
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/hascc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(with_cc(Some("carol@x.com"))))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/nocc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(with_cc(None)))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/gone"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // A seeded or synthetic id Gmail rejects outright, with Gmail's body.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/demo-seed-001"))
            .respond_with(ResponseTemplate::new(400).set_body_json(gmail_error(
                "Invalid id value",
                "invalidArgument",
                "INVALID_ARGUMENT",
            )))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/limited"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let (user, acct) = mailbox(&pool).await;
        // Rows as stored before Cc existed: cc_encrypted NULL. The rejected id
        // is the newest, so it is fetched first and must not hold up the rest;
        // the refused one is the oldest, so it is fetched last.
        let now = Utc::now().naive_utc();
        let mut ids = Vec::new();
        for (i, g) in ["demo-seed-001", "hascc", "nocc", "gone", "limited"]
            .iter()
            .enumerate()
        {
            let id: i32 = sqlx::query_scalar(
                "INSERT INTO emails (gmail_id, account_id, created_at) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(g)
            .bind(acct)
            .bind(now - Duration::minutes(i as i64))
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("email: {e}"));
            ids.push(id);
        }

        let n = backfill_batch(&pool, acct, &MailProvider::Google, "tok")
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }

        assert_eq!(n, 4);
        assert_eq!(
            cc_of(&pool, ids[0], user).await.as_deref(),
            Some(""),
            "an id Gmail rejects is recorded as having no Cc, not retried"
        );
        assert_eq!(
            cc_of(&pool, ids[1], user).await.as_deref(),
            Some("carol@x.com")
        );
        assert_eq!(cc_of(&pool, ids[2], user).await.as_deref(), Some(""));
        assert_eq!(
            cc_of(&pool, ids[3], user).await.as_deref(),
            Some(""),
            "a deleted message is recorded as having no Cc"
        );
        assert_eq!(
            cc_of(&pool, ids[4], user).await,
            None,
            "a refused fetch is never recorded as no Cc"
        );

        let outlook = backfill_batch(&pool, acct, &MailProvider::Microsoft, "tok")
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));
        assert_eq!(outlook, 0, "only Gmail mail is backfilled");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_mailbox_wide_400_is_never_recorded_as_no_cc() {
        ensure_aes_key();
        let mock = MockServer::start().await;
        // Gmail turned off for a Workspace user: every message answers 400.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/real1"))
            .respond_with(ResponseTemplate::new(400).set_body_json(gmail_error(
                "Mail service not enabled",
                "failedPrecondition",
                "FAILED_PRECONDITION",
            )))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let (user, acct) = mailbox(&pool).await;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, created_at) VALUES ('real1', $1, NOW()) RETURNING id",
        )
        .bind(acct)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        let n = backfill_batch(&pool, acct, &MailProvider::Google, "tok")
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }

        assert_eq!(n, 0);
        assert_eq!(
            cc_of(&pool, id, user).await,
            None,
            "left unknown for a later tick, not recorded as no Cc"
        );
    }
}
