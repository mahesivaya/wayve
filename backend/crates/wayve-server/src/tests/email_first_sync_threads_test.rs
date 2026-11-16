// The first sync after a Gmail account connects pulls whole Inbox conversations
// (`threads.list` + `threads.get`), so every message of a conversation lands at
// once, including the user's own replies, and one conversation that fails to
// load doesn't stop the rest.
#[cfg(test)]
mod tests {
    use crate::email::sync::sync_account_recent;
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn mailbox(pool: &PgPool) -> (i32, i32) {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) \
             VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, account)
    }

    fn message(id: &str, thread: &str, labels: &[&str], subject: &str, millis: i64) -> Value {
        json!({
            "id": id,
            "threadId": thread,
            "labelIds": labels,
            "internalDate": millis.to_string(),
            "payload": { "headers": [
                { "name": "From", "value": "Ann <ann@example.com>" },
                { "name": "To", "value": "me@example.com" },
                { "name": "Subject", "value": subject },
                { "name": "Message-Id", "value": format!("<{id}@example.com>") },
            ]},
        })
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
        let (user, account) = mailbox(&pool).await;
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
        // A conversation of the user's question, Ann's unread reply and the
        // user's own follow-up, which carries SENT rather than INBOX.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/t1"))
            .and(query_param("format", "metadata"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "t1",
                "messages": [
                    message("m1", "t1", &["INBOX"], "Lunch?", 1_700_000_000_000),
                    message("m2", "t1", &["INBOX", "UNREAD"], "Re: Lunch?", 1_700_000_100_000),
                    message("m3", "t1", &["SENT"], "Re: Lunch?", 1_700_000_200_000),
                ],
            })))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/t2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "t2",
                "messages": [message("m4", "t2", &["INBOX"], "Invoice", 1_700_000_300_000)],
            })))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/t-broken"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let result = sync_account_recent(&pool, account, "token", 50).await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };
        result.unwrap_or_else(|e| panic!("first sync: {e}"));

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

        cleanup(&pool, user).await;
    }
}
