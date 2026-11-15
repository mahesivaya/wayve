// Finished-backfill bookkeeping (email/backfill_state.rs) against a real
// Postgres: a marked kind is reported finished, a stale mark is not (so it gets
// re-checked), reopen clears one kind only, and the Cc backfill marks itself
// finished once nothing is left to fill in.
#[cfg(test)]
mod tests {
    use crate::email::backfill_state as state;
    use crate::email::provider::MailProvider;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;

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
    async fn marks_expire_and_reopen_clears_one_kind() {
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        assert!(state::finished(&pool, account).await.is_empty());

        state::mark_finished(&pool, account, state::THREADING).await;
        state::mark_finished(&pool, account, &state::label("SENT")).await;
        let done = state::finished(&pool, account).await;
        assert!(done.contains(state::THREADING));
        assert!(done.contains("label:SENT"));

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
        assert!(!done.contains("label:SENT"));
        assert!(done.contains(state::THREADING));

        state::reopen(&pool, account, state::THREADING).await;
        assert!(
            !state::finished(&pool, account)
                .await
                .contains(state::THREADING)
        );
    }

    #[actix_web::test]
    async fn cc_backfill_marks_itself_finished_when_nothing_is_pending() {
        let pool = test_pool().await;
        let account = mailbox(&pool).await;
        let filled = crate::email::cc_backfill::backfill_batch(
            &pool,
            account,
            &MailProvider::Google,
            "token",
        )
        .await
        .unwrap_or_else(|e| panic!("cc backfill: {e}"));
        assert_eq!(filled, 0);
        assert!(state::finished(&pool, account).await.contains(state::CC));
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
