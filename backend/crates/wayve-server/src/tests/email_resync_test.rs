// Gmail sync re-fetches the last hour every tick (email/sync.rs). The upsert in
// email/repo.rs must leave unchanged rows alone (no rewrite, no re-encryption,
// not returned, so not re-threaded) and still apply real changes: labels, a
// read flag, a newly known Cc, and the cleanup of a legacy plaintext subject.
#[cfg(test)]
mod tests {
    use crate::email::repo::{InsertEmail, upsert_batch};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::{NaiveDateTime, Utc};
    use sqlx::PgPool;

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

    async fn mailbox(pool: &PgPool) -> i32 {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"))
    }

    fn row<'a>(
        created_at: NaiveDateTime,
        cc: Option<&'a str>,
        is_read: bool,
        labels: &'a [String],
    ) -> InsertEmail<'a> {
        InsertEmail {
            gmail_id: "m1",
            sender: "ada@x.com",
            receiver: "me@x.com",
            cc,
            subject: "Plans",
            created_at,
            is_read,
            labels,
            body: None,
            attachments_checked: false,
        }
    }

    async fn subject_ct(pool: &PgPool, account: i32) -> String {
        sqlx::query_scalar(
            "SELECT subject_encrypted FROM emails WHERE account_id = $1 AND gmail_id = 'm1'",
        )
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("subject: {e}"))
    }

    async fn upsert(pool: &PgPool, account: i32, r: InsertEmail<'_>) -> usize {
        upsert_batch(pool, account, &[r])
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"))
            .len()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn resync_skips_unchanged_rows_and_applies_changes() {
        ensure_aes_key();
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        // Postgres keeps microseconds; strip below that so a re-sync compares equal.
        let at = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros())
            .unwrap_or_else(|| panic!("timestamp"))
            .naive_utc();
        let inbox = vec!["INBOX".to_string()];

        assert_eq!(
            upsert(&pool, account, row(at, Some(""), false, &inbox)).await,
            1
        );
        let first = subject_ct(&pool, account).await;

        // Same message again: not rewritten, not returned.
        assert_eq!(
            upsert(&pool, account, row(at, Some(""), false, &inbox)).await,
            0
        );
        assert_eq!(
            upsert(&pool, account, row(at, None, false, &inbox)).await,
            0
        );
        assert_eq!(subject_ct(&pool, account).await, first, "no re-encryption");

        // A label change is applied and returned, as not new.
        let starred = vec!["INBOX".to_string(), "STARRED".to_string()];
        let changed = upsert_batch(&pool, account, &[row(at, Some(""), false, &starred)])
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"));
        assert_eq!(changed.len(), 1);
        assert!(!changed[0].is_new);

        // Read in Gmail: applied. Unread again in Gmail: monotonic, so no write.
        assert_eq!(
            upsert(&pool, account, row(at, Some(""), true, &starred)).await,
            1
        );
        assert_eq!(
            upsert(&pool, account, row(at, Some(""), false, &starred)).await,
            0
        );

        // A Cc going from none to known is applied.
        assert_eq!(
            upsert(&pool, account, row(at, Some("carol@x.com"), true, &starred)).await,
            1
        );

        // A legacy plaintext subject left on the row is still cleared.
        sqlx::query("UPDATE emails SET subject = 'Plans' WHERE account_id = $1")
            .bind(account)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("legacy: {e}"));
        assert_eq!(
            upsert(&pool, account, row(at, Some("carol@x.com"), true, &starred)).await,
            1
        );
        let legacy: Option<String> =
            sqlx::query_scalar("SELECT subject FROM emails WHERE account_id = $1")
                .bind(account)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("legacy read: {e}"));
        assert_eq!(legacy, None);
    }
}
