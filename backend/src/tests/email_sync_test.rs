#[cfg(test)]
mod tests {
    use crate::email::sync::{fetch_headers_only, fetch_ids, sync_account, sync_account_recent};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use serde_json::json;
    use wiremock::matchers::{method, path, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn set_env(key: &str, val: &str) {
        unsafe {
            std::env::set_var(key, val);
        }
    }

    /// Build a Gmail message-list response page.
    fn page(ids: &[&str], next: Option<&str>) -> serde_json::Value {
        let messages: Vec<_> = ids.iter().map(|id| json!({ "id": id })).collect();
        match next {
            Some(t) => json!({ "messages": messages, "nextPageToken": t }),
            None => json!({ "messages": messages }),
        }
    }

    fn metadata_response(
        from: &str,
        to: &str,
        subject: &str,
        internal_date_ms: i64,
    ) -> serde_json::Value {
        json!({
            "internalDate": internal_date_ms.to_string(),
            "payload": {
                "headers": [
                    { "name": "From", "value": from },
                    { "name": "To", "value": to },
                    { "name": "Subject", "value": subject },
                ]
            }
        })
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fetch_ids_walks_paginated_responses() {
        let server = MockServer::start().await;
        set_env("GMAIL_API_BASE", &server.uri());

        // First page returns 2 ids + nextPageToken; second page returns 1 id and no token.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .and(query_param("maxResults", "100"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(page(&["a", "b"], Some("PAGE2"))),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .and(query_param("pageToken", "PAGE2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(&["c"], None)))
            .mount(&server)
            .await;

        let ids = fetch_ids("fake-token", None).await.expect("fetch_ids ok");
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fetch_headers_only_extracts_from_to_subject() {
        let server = MockServer::start().await;
        set_env("GMAIL_API_BASE", &server.uri());

        Mock::given(method("GET"))
            .and(path_regex(r"^/gmail/v1/users/me/messages/.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(metadata_response(
                "Alice <a@x.com>",
                "Bob <b@y.com>",
                "Hello world",
                1_700_000_000_000,
            )))
            .mount(&server)
            .await;

        let (id, from, to, subject, created_at, _is_read) =
            fetch_headers_only("token", "msg-1").await.unwrap();
        assert_eq!(id, "msg-1");
        assert_eq!(from, "Alice <a@x.com>");
        assert_eq!(to, "Bob <b@y.com>");
        assert_eq!(subject, "Hello world");
        assert_eq!(
            created_at,
            chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
                .unwrap()
                .naive_utc()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sync_account_inserts_email_rows_and_advances_last_sync() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        let acc_row = sqlx::query(
            "INSERT INTO email_accounts (email, user_id, access_token, refresh_token, token_expiry, is_active)
             VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 hour', true)
             RETURNING id",
        )
        .bind(&email)
        .bind(user_id)
        .bind("fake-access")
        .bind("fake-refresh")
        .fetch_one(&pool)
        .await
        .unwrap();
        let account_id: i32 = sqlx::Row::get(&acc_row, "id");

        let server = MockServer::start().await;
        set_env("GMAIL_API_BASE", &server.uri());

        // List returns two ids in one page.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(&["m1", "m2"], None)))
            .mount(&server)
            .await;

        // Per-message metadata for both.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/m1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(metadata_response(
                "from1@x.com",
                "to1@x.com",
                "Subject 1",
                1_700_000_000_000,
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/m2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(metadata_response(
                "from2@x.com",
                "to2@x.com",
                "Subject 2",
                1_700_000_100_000,
            )))
            .mount(&server)
            .await;

        sync_account(&pool, account_id, "tok", None).await.unwrap();

        let rows = sqlx::query(
            "SELECT gmail_id, sender, receiver, subject, body_encrypted, created_at FROM emails WHERE account_id = $1 ORDER BY gmail_id",
        )
        .bind(account_id)
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        let gmail_ids: Vec<String> = rows.iter().map(|r| sqlx::Row::get(r, "gmail_id")).collect();
        assert_eq!(gmail_ids, vec!["m1".to_string(), "m2".to_string()]);
        let created_at: Vec<chrono::NaiveDateTime> = rows
            .iter()
            .map(|r| sqlx::Row::get(r, "created_at"))
            .collect();
        assert_eq!(
            created_at,
            vec![
                chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
                    .unwrap()
                    .naive_utc(),
                chrono::DateTime::from_timestamp_millis(1_700_000_100_000)
                    .unwrap()
                    .naive_utc(),
            ]
        );
        for r in &rows {
            let body: String = sqlx::Row::get(r, "body_encrypted");
            assert!(
                body.is_empty(),
                "sync_account leaves body empty for body_worker"
            );
        }

        // last_sync should now be set.
        let ls: Option<i64> =
            sqlx::query_scalar("SELECT last_sync FROM email_accounts WHERE id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(ls.is_some());

        // cleanup
        sqlx::query("DELETE FROM emails WHERE account_id = $1")
            .bind(account_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM email_accounts WHERE id = $1")
            .bind(account_id)
            .execute(&pool)
            .await
            .ok();
        crate::test_support::delete_user(&pool, user_id).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sync_account_recent_advances_last_sync() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        let acc_row = sqlx::query(
            "INSERT INTO email_accounts (email, user_id, access_token, refresh_token, token_expiry, is_active)
             VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 hour', true)
             RETURNING id",
        )
        .bind(&email)
        .bind(user_id)
        .bind("fake-access")
        .bind("fake-refresh")
        .fetch_one(&pool)
        .await
        .unwrap();
        let account_id: i32 = sqlx::Row::get(&acc_row, "id");

        let server = MockServer::start().await;
        set_env("GMAIL_API_BASE", &server.uri());

        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page(&["recent-1"], None)))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/recent-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(metadata_response(
                "from@x.com",
                &email,
                "Recent subject",
                1_700_000_000_000,
            )))
            .mount(&server)
            .await;

        sync_account_recent(&pool, account_id, "tok", 51)
            .await
            .unwrap();

        let last_sync: Option<i64> =
            sqlx::query_scalar("SELECT last_sync FROM email_accounts WHERE id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(last_sync.is_some());

        sqlx::query("DELETE FROM emails WHERE account_id = $1")
            .bind(account_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM email_accounts WHERE id = $1")
            .bind(account_id)
            .execute(&pool)
            .await
            .ok();
        crate::test_support::delete_user(&pool, user_id).await;
    }
}
