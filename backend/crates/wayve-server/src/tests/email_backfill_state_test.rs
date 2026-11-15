// Finished-backfill bookkeeping (email/backfill_state.rs) against a real
// Postgres: a marked backfill is reported finished, a stale mark is not (so it
// gets re-checked), reopen clears one backfill only, `run` marks an exhausted
// batch, never polls a finished one and keeps the state on error, and a Gmail
// error reply surfaces as an error rather than an empty page.
#[cfg(test)]
mod tests {
    use crate::email::backfill_state::{self as state, Backfill, Batch};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;
    use std::sync::atomic::{AtomicBool, Ordering};

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

    #[actix_web::test]
    async fn marks_expire_and_reopen_clears_one_backfill() {
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        assert!(
            !state::finished(&pool, account)
                .await
                .contains(Backfill::Threading)
        );

        state::mark_finished(&pool, account, Backfill::Threading).await;
        state::mark_finished(&pool, account, Backfill::Label("SENT")).await;
        let done = state::finished(&pool, account).await;
        assert!(done.contains(Backfill::Threading));
        assert!(done.contains(Backfill::Label("SENT")));
        assert!(!done.contains(Backfill::Label("DRAFT")));

        // A mark older than the re-check window no longer counts.
        sqlx::query(
            "UPDATE email_accounts SET backfill_done = backfill_done || \
             jsonb_build_object('label:SENT', NOW() - INTERVAL '25 hours') WHERE id = $1",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("age mark: {e}"));
        let done = state::finished(&pool, account).await;
        assert!(!done.contains(Backfill::Label("SENT")));
        assert!(done.contains(Backfill::Threading));

        state::reopen(&pool, account, Backfill::Threading).await;
        let done = state::finished(&pool, account).await;
        assert!(!done.contains(Backfill::Threading));
    }

    #[actix_web::test]
    async fn run_marks_exhausted_skips_finished_and_keeps_state_on_error() {
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        let done = state::finished(&pool, account).await;

        // More leaves it open; an error leaves it open too.
        state::run(&pool, account, &done, Backfill::Cc, async {
            Ok(Batch::More)
        })
        .await;
        state::run(&pool, account, &done, Backfill::Older, async {
            Err(anyhow::anyhow!("gmail said 429"))
        })
        .await;
        let after = state::finished(&pool, account).await;
        assert!(!after.contains(Backfill::Cc), "{after:?}");
        assert!(!after.contains(Backfill::Older), "{after:?}");

        // Exhausted marks it finished.
        state::run(&pool, account, &done, Backfill::Cc, async {
            Ok(Batch::Exhausted)
        })
        .await;
        let done = state::finished(&pool, account).await;
        assert!(done.contains(Backfill::Cc));

        // A finished backfill's batch is never polled.
        let ran = AtomicBool::new(false);
        state::run(&pool, account, &done, Backfill::Cc, async {
            ran.store(true, Ordering::SeqCst);
            Ok(Batch::More)
        })
        .await;
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[test]
    fn an_empty_pending_list_is_exhausted() {
        assert_eq!(Batch::from_pending(0), Batch::Exhausted);
        assert_eq!(Batch::from_pending(3), Batch::More);
    }

    /// A Gmail error reply must surface as an error: read as an empty page, it
    /// would mark the backfill finished and stop it for a day.
    #[actix_web::test]
    #[serial_test::serial]
    async fn a_gmail_error_reply_is_not_an_empty_page() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
                "error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}
            })))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }
        let label = crate::email::sync::fetch_label_ids_before("token", "SENT", 1, 50).await;
        let older = crate::email::sync::fetch_ids_before("token", 1, 50).await;
        let query = crate::email::sync::fetch_query_ids("token", "from:github.com", None, 50).await;
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }
        assert!(label.is_err(), "label list: {label:?}");
        assert!(older.is_err(), "older list: {older:?}");
        assert!(query.is_err(), "query list: {query:?}");
    }
}
