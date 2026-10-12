// Gmail label changes reach stored mail through Gmail's change history:
// archiving older mail takes it out of the Inbox, re-marking it unread makes it
// unread, and labels Fluxze adds itself survive.
#[cfg(test)]
mod tests {
    use crate::email::label_history::{LabelChange, parse_label_changes, sync_label_changes};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn mailbox(pool: &PgPool, position: Option<i64>) -> (i32, i32) {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, label_history_id) \
             VALUES ($1, $2, 'google', $3) RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .bind(position)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, account)
    }

    async fn email(pool: &PgPool, account: i32, gmail_id: &str, labels: &[&str], read: bool) {
        sqlx::query(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, is_read) \
             VALUES ($1, $2, 'ann@x.com', $3, $4)",
        )
        .bind(gmail_id)
        .bind(account)
        .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        .bind(read)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
    }

    async fn stored(pool: &PgPool, account: i32, gmail_id: &str) -> (Vec<String>, bool) {
        let (mut labels, read): (Vec<String>, bool) = sqlx::query_as(
            "SELECT labels, is_read FROM emails WHERE account_id = $1 AND gmail_id = $2",
        )
        .bind(account)
        .bind(gmail_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("stored: {e}"));
        labels.sort();
        (labels, read)
    }

    async fn position(pool: &PgPool, account: i32) -> Option<i64> {
        sqlx::query_scalar("SELECT label_history_id FROM email_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("position: {e}"))
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

    #[test]
    fn parses_added_and_removed_labels_in_order() {
        let page = serde_json::json!({
            "history": [
                { "id": "11", "labelsRemoved": [
                    { "message": { "id": "m1" }, "labelIds": ["INBOX"] } ] },
                { "id": "12", "labelsAdded": [
                    { "message": { "id": "m2" }, "labelIds": ["UNREAD", "Label_1"] } ] },
                { "id": "13", "messages": [ { "id": "m3" } ] }
            ],
            "historyId": "13"
        });
        assert_eq!(
            parse_label_changes(&page),
            vec![
                LabelChange {
                    gmail_id: "m1".into(),
                    added: vec![],
                    removed: vec!["INBOX".into()],
                },
                LabelChange {
                    gmail_id: "m2".into(),
                    added: vec!["UNREAD".into(), "Label_1".into()],
                    removed: vec![],
                },
            ]
        );
        assert!(parse_label_changes(&serde_json::json!({ "historyId": "1" })).is_empty());
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn applies_gmail_label_changes_to_stored_mail() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, Some(100)).await;
        email(
            &pool,
            account,
            "archived",
            &["INBOX", "WAYVE_GITHUB_PR"],
            true,
        )
        .await;
        email(&pool, account, "re_unread", &["INBOX"], true).await;
        email(&pool, account, "read_there", &["INBOX", "UNREAD"], false).await;

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/history"))
            .and(query_param("startHistoryId", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "history": [
                    { "id": "101", "labelsRemoved": [
                        { "message": { "id": "archived" }, "labelIds": ["INBOX"] } ] },
                    { "id": "102", "labelsAdded": [
                        { "message": { "id": "re_unread" }, "labelIds": ["UNREAD"] } ] },
                    { "id": "103", "labelsRemoved": [
                        { "message": { "id": "read_there" }, "labelIds": ["UNREAD"] } ] },
                    { "id": "104", "labelsAdded": [
                        { "message": { "id": "not_stored" }, "labelIds": ["STARRED"] } ] }
                ],
                "historyId": "150"
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let synced = with_gmail(&mock, sync_label_changes(&pool, account, "tok")).await;
        synced.unwrap_or_else(|e| panic!("sync: {e}"));
        mock.verify().await;

        // Archived in Gmail: out of the Inbox, Fluxze's own label kept.
        assert_eq!(
            stored(&pool, account, "archived").await,
            (vec!["WAYVE_GITHUB_PR".to_string()], true)
        );
        assert_eq!(
            stored(&pool, account, "re_unread").await,
            (vec!["INBOX".to_string(), "UNREAD".to_string()], false)
        );
        assert_eq!(
            stored(&pool, account, "read_there").await,
            (vec!["INBOX".to_string()], true)
        );
        assert_eq!(position(&pool, account).await, Some(150));

        cleanup(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn starts_from_gmails_current_position_and_again_when_it_expires() {
        let pool = test_pool().await;
        let (user, account) = mailbox(&pool, None).await;
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/profile"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "historyId": "500" })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/history"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;

        // First run: only records where history stands; no history read.
        let first = with_gmail(&mock, sync_label_changes(&pool, account, "tok")).await;
        first.unwrap_or_else(|e| panic!("first: {e}"));
        assert_eq!(position(&pool, account).await, Some(500));

        // Too old for Gmail: start again from its current position.
        sqlx::query("UPDATE email_accounts SET label_history_id = 7 WHERE id = $1")
            .bind(account)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("rewind: {e}"));
        let expired = with_gmail(&mock, sync_label_changes(&pool, account, "tok")).await;
        expired.unwrap_or_else(|e| panic!("expired: {e}"));
        assert_eq!(position(&pool, account).await, Some(500));

        cleanup(&pool, user).await;
    }
}
