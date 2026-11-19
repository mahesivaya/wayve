// `sync_one_account` reports an account's post-sync `last_message_at` through
// the `STAMPED_LAST_MESSAGE` task-local that the upsert's stamp fills in, instead
// of the scheduler reading the row back once per account. These pin down what
// the slot sees: the stored (GREATEST) value for new mail, nothing for a re-sync
// or another account's mail, and no effect at all outside a sync.
#[cfg(test)]
mod tests {
    use crate::email::repo::{InsertEmail, STAMPED_LAST_MESSAGE, upsert_batch};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::{Duration, NaiveDateTime, Utc};
    use sqlx::PgPool;
    use std::cell::Cell;

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

    /// Now, truncated to the microseconds Postgres keeps, minus `hours_ago`.
    fn at(hours_ago: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros())
            .unwrap_or_else(|| panic!("timestamp"))
            .naive_utc()
            - Duration::hours(hours_ago)
    }

    async fn upsert(pool: &PgPool, account: i32, gmail_id: &str, created_at: NaiveDateTime) {
        let labels = vec!["INBOX".to_string()];
        let row = InsertEmail {
            gmail_id,
            sender: "ada@x.com",
            receiver: "me@x.com",
            cc: None,
            subject: "Plans",
            created_at,
            is_read: false,
            labels: &labels,
            body: None,
            attachments_checked: false,
        };
        upsert_batch(pool, account, &[row])
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"));
    }

    async fn stored(pool: &PgPool, account: i32) -> Option<NaiveDateTime> {
        sqlx::query_scalar("SELECT last_message_at FROM email_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("last_message_at: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_slot_reports_the_stored_stamp_for_new_mail_only() {
        ensure_aes_key();
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        let newest = at(1);

        let reported = STAMPED_LAST_MESSAGE
            .scope(Cell::new((account, None)), async {
                // New mail advances the slot to what was stored.
                upsert(&pool, account, "m-new", newest).await;
                let after_new = STAMPED_LAST_MESSAGE.with(|s| s.get().1);
                assert_eq!(after_new, Some(newest));

                // An older message (a backfill page) is new too, but GREATEST
                // keeps the stored stamp, and the slot reports that, not the
                // older time.
                upsert(&pool, account, "m-old", at(48)).await;
                // A re-sync of an existing row isn't new and stamps nothing.
                upsert(&pool, account, "m-new", newest).await;
                STAMPED_LAST_MESSAGE.with(|s| s.get().1)
            })
            .await;

        assert_eq!(reported, Some(newest));
        assert_eq!(stored(&pool, account).await, Some(newest));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_slot_ignores_another_accounts_mail_and_is_optional() {
        ensure_aes_key();
        let pool = test_pool().await;
        let syncing = mailbox(&pool).await;
        let other = mailbox(&pool).await;

        let reported = STAMPED_LAST_MESSAGE
            .scope(Cell::new((syncing, None)), async {
                upsert(&pool, other, "o-1", at(1)).await;
                STAMPED_LAST_MESSAGE.with(|s| s.get().1)
            })
            .await;
        assert_eq!(reported, None, "another account's stamp must not leak in");
        assert_eq!(
            stored(&pool, other).await,
            Some(at_micro(&pool, other).await)
        );

        // Outside any sync (no slot) the upsert still stamps the row and
        // doesn't panic.
        let fresh = at(0);
        upsert(&pool, syncing, "s-1", fresh).await;
        assert_eq!(stored(&pool, syncing).await, Some(fresh));
    }

    /// The created_at of the only email on `account`, as stored.
    async fn at_micro(pool: &PgPool, account: i32) -> NaiveDateTime {
        sqlx::query_scalar("SELECT created_at FROM emails WHERE account_id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("created_at: {e}"))
    }
}
