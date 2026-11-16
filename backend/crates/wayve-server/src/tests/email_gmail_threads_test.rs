// Gmail mail arrives as whole conversations: the first sync after connecting
// pulls the newest Inbox threads (`threads.list` + `threads.get`), and the
// backfill walks all mail newest to oldest, loading each listed message's
// conversation in one call. The backfill keeps its own cursor, so a
// conversation that reaches far back never makes it skip the mail in between.
#[cfg(test)]
mod tests {
    use crate::email::sync::{backfill_gmail_threads, sync_account_recent};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn mailbox(pool: &PgPool, backfill_before: Option<i64>) -> (i32, i32) {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, backfill_before) \
             VALUES ($1, $2, 'google', $3) RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .bind(backfill_before)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, account)
    }

    /// A Gmail message in `format=metadata` shape, dated `secs` (Unix seconds).
    fn message(id: &str, thread: &str, labels: &[&str], subject: &str, secs: i64) -> Value {
        json!({
            "id": id,
            "threadId": thread,
            "labelIds": labels,
            "internalDate": (secs * 1000).to_string(),
            "payload": { "headers": [
                { "name": "From", "value": "Ann <ann@example.com>" },
                { "name": "To", "value": "me@example.com" },
                { "name": "Subject", "value": subject },
                { "name": "Message-Id", "value": format!("<{id}@example.com>") },
            ]},
        })
    }

    async fn mock_thread(mock: &MockServer, thread: &str, messages: Vec<Value>) {
        Mock::given(method("GET"))
            .and(path(format!("/gmail/v1/users/me/threads/{thread}")))
            .and(query_param("format", "metadata"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "id": thread, "messages": messages })),
            )
            .expect(1)
            .mount(mock)
            .await;
    }

    /// Lists `refs` as the all-mail page older than `before`.
    async fn mock_listing(mock: &MockServer, before: i64, refs: &[(&str, &str)]) {
        let messages: Vec<Value> = refs
            .iter()
            .map(|(id, thread)| json!({ "id": id, "threadId": thread }))
            .collect();
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .and(query_param("q", format!("before:{before}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "messages": messages })))
            .expect(1)
            .mount(mock)
            .await;
    }

    async fn stored(pool: &PgPool, account: i32) -> Vec<(String, bool, Vec<String>)> {
        sqlx::query_as(
            "SELECT gmail_id, is_read, labels FROM emails WHERE account_id = $1 ORDER BY gmail_id",
        )
        .bind(account)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("stored: {e}"))
    }

    async fn cursor(pool: &PgPool, account: i32) -> Option<i64> {
        sqlx::query_scalar("SELECT backfill_before FROM email_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("cursor: {e}"))
    }

    async fn with_gmail<T>(mock: &MockServer, f: impl std::future::Future<Output = T>) -> T {
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let out = f.await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };
        out
    }

    async fn cleanup(pool: &PgPool, user: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(pool)
            .await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn first_sync_saves_every_message_of_each_inbox_thread() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, None).await;
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads"))
            .and(query_param("labelIds", "INBOX"))
            .and(query_param("maxResults", "50"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "threads": [{ "id": "t1" }, { "id": "t2" }, { "id": "t-broken" }]
            })))
            .expect(1)
            .mount(&mock)
            .await;
        // The user's question, Ann's unread reply and the user's own follow-up,
        // which carries SENT rather than INBOX.
        mock_thread(
            &mock,
            "t1",
            vec![
                message("m1", "t1", &["INBOX"], "Lunch?", 1_700_000_000),
                message(
                    "m2",
                    "t1",
                    &["INBOX", "UNREAD"],
                    "Re: Lunch?",
                    1_700_000_100,
                ),
                message("m3", "t1", &["SENT"], "Re: Lunch?", 1_700_000_200),
            ],
        )
        .await;
        mock_thread(
            &mock,
            "t2",
            vec![message("m4", "t2", &["INBOX"], "Invoice", 1_700_000_300)],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/t-broken"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;

        let started = chrono::Utc::now().timestamp();
        with_gmail(&mock, sync_account_recent(&pool, account, "token", 50))
            .await
            .unwrap_or_else(|e| panic!("first sync: {e}"));

        let rows = stored(&pool, account).await;
        let ids: Vec<&str> = rows.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m3", "m4"]);
        let m2 = rows.iter().find(|r| r.0 == "m2");
        assert_eq!(m2.map(|r| r.1), Some(false), "UNREAD reply stays unread");
        let m3 = rows.iter().find(|r| r.0 == "m3");
        assert_eq!(m3.map(|r| r.2.clone()), Some(vec!["SENT".to_string()]));

        // The three messages of t1 share one conversation.
        let conversations: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT thread_id) FROM emails \
             WHERE account_id = $1 AND gmail_id IN ('m1', 'm2', 'm3')",
        )
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("conversations: {e}"));
        assert_eq!(conversations, 1);

        // The backfill starts from when the account connected, not from the
        // oldest message these conversations brought.
        let seeded = cursor(&pool, account).await;
        assert!(
            seeded.is_some_and(|c| c >= started),
            "cursor seeded to connect time, got {seeded:?}"
        );

        cleanup(&pool, user).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_loads_listed_conversations_and_moves_cursor_to_oldest_listed() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, Some(2_000)).await;
        // Already stored: listed again, but its conversation isn't re-fetched.
        sqlx::query(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, created_at) \
             VALUES ('c1', $1, 'ann@x.com', '{INBOX}', to_timestamp(1900) AT TIME ZONE 'UTC')",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed c1: {e}"));

        let mock = MockServer::start().await;
        mock_listing(
            &mock,
            2_000,
            &[("c1", "tC"), ("a1", "tA"), ("b1", "tB"), ("b2", "tB")],
        )
        .await;
        // tA started long before the walk has reached; a0 comes along with it.
        mock_thread(
            &mock,
            "tA",
            vec![
                message("a0", "tA", &["INBOX"], "Old start", 500),
                message("a1", "tA", &["INBOX"], "Re: Old start", 1_500),
            ],
        )
        .await;
        mock_thread(
            &mock,
            "tB",
            vec![
                message("b2", "tB", &["INBOX"], "Plan", 1_300),
                message("b1", "tB", &["INBOX"], "Re: Plan", 1_400),
            ],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/tC"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&mock)
            .await;

        with_gmail(&mock, backfill_gmail_threads(&pool, account, "token"))
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));

        let ids: Vec<String> = stored(&pool, account)
            .await
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        assert_eq!(ids, ["a0", "a1", "b1", "b2", "c1"]);
        // b2 is the oldest listed message; a0 (500) must not drag the cursor back.
        assert_eq!(cursor(&pool, account).await, Some(1_300));
        mock.verify().await;

        cleanup(&pool, user).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_loads_messages_one_by_one_when_their_conversation_fails() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, Some(2_000)).await;
        let mock = MockServer::start().await;
        mock_listing(&mock, 2_000, &[("d1", "tD")]).await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/tD"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/d1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "d1",
                "tD",
                &["INBOX"],
                "Hi",
                1_800,
            )))
            .expect(1)
            .mount(&mock)
            .await;

        with_gmail(&mock, backfill_gmail_threads(&pool, account, "token"))
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));

        let ids: Vec<String> = stored(&pool, account)
            .await
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        assert_eq!(ids, ["d1"]);
        assert_eq!(cursor(&pool, account).await, Some(1_800));

        cleanup(&pool, user).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_keeps_cursor_when_a_listed_message_cannot_be_stored() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, Some(2_000)).await;
        let mock = MockServer::start().await;
        mock_listing(&mock, 2_000, &[("e1", "tE")]).await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/tE"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/e1"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;

        let result = with_gmail(&mock, backfill_gmail_threads(&pool, account, "token")).await;
        assert!(result.is_err(), "unstored mail fails the step for a retry");
        assert_eq!(cursor(&pool, account).await, Some(2_000));

        cleanup(&pool, user).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_seeds_cursor_from_oldest_stored_email_for_existing_accounts() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, None).await;
        sqlx::query(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, created_at) \
             VALUES ('old', $1, 'ann@x.com', '{INBOX}', to_timestamp(3000) AT TIME ZONE 'UTC')",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed old: {e}"));

        let mock = MockServer::start().await;
        mock_listing(&mock, 3_000, &[("f1", "tF")]).await;
        mock_thread(
            &mock,
            "tF",
            vec![message("f1", "tF", &["INBOX"], "Older", 2_500)],
        )
        .await;

        with_gmail(&mock, backfill_gmail_threads(&pool, account, "token"))
            .await
            .unwrap_or_else(|e| panic!("backfill: {e}"));

        assert_eq!(cursor(&pool, account).await, Some(2_500));
        mock.verify().await;

        cleanup(&pool, user).await;
    }
}
