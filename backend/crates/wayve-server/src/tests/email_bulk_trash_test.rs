// Bulk Trash / Restore (routes/email.rs bulk_move): one request moves many
// emails, with one ownership query, one token refresh per mailbox, the
// provider's batch call (Gmail batchModify, Graph $batch, both mocked here),
// one database update and one audit row. Partial by design: emails that can't
// move are reported with their reason, and the rest still move.
#[cfg(test)]
mod tests {
    use crate::email::provider::{
        GoogleMailClient, GoogleOAuthClient, MailTrash, OutlookMailClient, TrashMoved,
    };
    use crate::email::repo;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::Value;
    use sqlx::PgPool;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    async fn user(pool: &PgPool) -> (i32, String) {
        let login = random_email();
        (insert_local_user(pool, &login, "password123").await, login)
    }

    /// Fluxze-to-Fluxze mail for `recipient`: no provider copy, so the bulk
    /// endpoints run end to end without one.
    async fn native(pool: &PgPool, recipient: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, source, recipient_user_id) \
             VALUES ($1, NULL, 'ada@x.com', ARRAY['INBOX']::text[], 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(recipient)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn labels(pool: &PgPool, id: i32) -> Vec<String> {
        sqlx::query_scalar("SELECT labels FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("labels: {e}"))
    }

    async fn call(
        pool: &PgPool,
        user: i32,
        login: &str,
        action: &str,
        ids: Value,
    ) -> (StatusCode, Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::trash_emails)
                .service(crate::routes::email::restore_emails),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri(&format!("/emails/{action}"))
            .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, login))))
            .set_json(serde_json::json!({ "ids": ids }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        let status = resp.status();
        let body: Value = actix_test::read_body_json(resp).await;
        (status, body)
    }

    async fn audits(pool: &PgPool, user: i32, action: &str) -> Vec<Value> {
        sqlx::query_scalar(
            "SELECT metadata FROM audit_logs WHERE actor_user_id = $1 AND action = $2 ORDER BY id",
        )
        .bind(user)
        .bind(action)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"))
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
    async fn many_emails_move_in_one_request_and_the_rest_are_reported() {
        let pool = test_pool().await;
        let (me, login) = user(&pool).await;
        let (stranger, _) = user(&pool).await;
        let mine = [
            native(&pool, me).await,
            native(&pool, me).await,
            native(&pool, me).await,
        ];
        let theirs = native(&pool, stranger).await;
        let missing = i32::MAX;

        let mut ids: Vec<i32> = mine.to_vec();
        ids.extend([theirs, missing, mine[0]]); // a duplicate counts once
        let (status, body) = call(&pool, me, &login, "trash", serde_json::json!(ids)).await;
        assert_eq!(status, StatusCode::OK);
        let mut done: Vec<i64> =
            serde_json::from_value(body["done"].clone()).unwrap_or_else(|e| panic!("done: {e}"));
        done.sort_unstable();
        let mut want: Vec<i64> = mine.iter().map(|&i| i64::from(i)).collect();
        want.sort_unstable();
        assert_eq!(done, want);
        // Someone else's mail and an unknown id fail alike, revealing nothing.
        let failed = body["failed"].as_array().cloned().unwrap_or_default();
        assert_eq!(failed.len(), 2);
        assert!(failed.iter().all(|f| f["error"] == "Email not found"));
        for id in mine {
            assert!(labels(&pool, id).await.contains(&"TRASH".to_string()));
        }
        assert!(!labels(&pool, theirs).await.contains(&"TRASH".to_string()));

        // One audit row for the whole request, listing what moved.
        let trashed = audits(&pool, me, "email_deleted").await;
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0]["count"], 3);
        assert_eq!(trashed[0]["failed"], 2);

        // And back again, also in one request.
        let (status, body) = call(&pool, me, &login, "restore", serde_json::json!(mine)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["done"].as_array().map(Vec::len), Some(3));
        assert_eq!(body["failed"].as_array().map(Vec::len), Some(0));
        for id in mine {
            assert_eq!(labels(&pool, id).await, ["INBOX"]);
        }
        assert_eq!(audits(&pool, me, "email_restored").await.len(), 1);

        cleanup(&pool, &[me, stranger]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_empty_or_oversized_request_is_refused() {
        let pool = test_pool().await;
        let (me, login) = user(&pool).await;
        let (status, _) = call(&pool, me, &login, "trash", serde_json::json!([])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let too_many: Vec<i32> = (1..=1001).collect();
        let (status, _) = call(&pool, me, &login, "restore", serde_json::json!(too_many)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        cleanup(&pool, &[me]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn one_statement_applies_each_emails_provider_result() {
        let pool = test_pool().await;
        let (me, _) = user(&pool).await;
        let a = native(&pool, me).await;
        let b = native(&pool, me).await;
        repo::set_trashed_many(
            &pool,
            true,
            &[(a, TrashMoved::default()), (b, TrashMoved::default())],
        )
        .await
        .unwrap_or_else(|e| panic!("trash: {e}"));
        assert!(labels(&pool, a).await.contains(&"TRASH".to_string()));
        // A restore stores a moved message's new id, and puts INBOX back only
        // where the provider says it landed there.
        sqlx::query("UPDATE emails SET labels = ARRAY['TRASH']::text[] WHERE id = ANY($1)")
            .bind(vec![a, b])
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("reset: {e}"));
        repo::set_trashed_many(
            &pool,
            false,
            &[
                (
                    a,
                    TrashMoved {
                        new_id: Some("moved-a".into()),
                        in_inbox: true,
                    },
                ),
                (b, TrashMoved::default()),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("restore: {e}"));
        assert_eq!(labels(&pool, a).await, ["INBOX"]);
        assert!(labels(&pool, b).await.is_empty());
        let gmail_id: String = sqlx::query_scalar("SELECT gmail_id FROM emails WHERE id = $1")
            .bind(a)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("gmail_id: {e}"));
        assert_eq!(gmail_id, "moved-a");
        cleanup(&pool, &[me]).await;
    }

    fn gmail() -> GoogleMailClient {
        GoogleMailClient {
            oauth: GoogleOAuthClient {
                client_id: "x".into(),
                client_secret: "y".into(),
            },
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gmail_moves_a_whole_batch_in_one_call() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/batchModify"))
            .and(body_json(serde_json::json!({
                "ids": ["m1", "m2", "m3"],
                "addLabelIds": ["TRASH"],
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/batchModify"))
            .and(body_json(serde_json::json!({
                "ids": ["m1", "m2", "m3"],
                "removeLabelIds": ["TRASH"],
                "addLabelIds": ["INBOX"],
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let ids: Vec<String> = ["m1", "m2", "m3"].map(String::from).to_vec();
        let trashed = gmail().move_many("tok", &ids, true).await;
        let restored = gmail().move_many("tok", &ids, false).await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        assert!(trashed.iter().all(|r| matches!(r, Ok(m) if !m.in_inbox)));
        assert!(restored.iter().all(|r| matches!(r, Ok(m) if m.in_inbox)));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_refused_gmail_batch_falls_back_to_one_by_one() {
        let mock = MockServer::start().await;
        // One bad id fails the whole batchModify...
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/batchModify"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&mock)
            .await;
        // ...so each message is trashed on its own, and only the bad one fails.
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/good/trash"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/bad/trash"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let ids: Vec<String> = ["good", "bad"].map(String::from).to_vec();
        let results = gmail().move_many("tok", &ids, true).await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        assert!(results[0].is_ok());
        assert!(results[1].is_err());
    }

    fn outlook() -> OutlookMailClient {
        OutlookMailClient {
            creds: crate::email::outlook::OutlookCredentials {
                client_id: "x".into(),
                client_secret: "y".into(),
                redirect_uri: "https://example.com/cb".into(),
            },
        }
    }

    /// Graph `$batch`: answers each move in reverse order (Graph doesn't keep
    /// it), giving `new-<n>` ids; a message named `gone` is a 404 and one
    /// named `bad` a 403.
    struct GraphBatch;

    impl Respond for GraphBatch {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
            let mut responses: Vec<Value> = body["requests"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    let url = r["url"].as_str().unwrap_or("");
                    let status = if url.contains("/gone/") {
                        404
                    } else if url.contains("/bad/") {
                        403
                    } else {
                        201
                    };
                    serde_json::json!({
                        "id": r["id"],
                        "status": status,
                        "body": { "id": format!("new-{}", r["id"].as_str().unwrap_or("")) },
                    })
                })
                .collect();
            responses.reverse();
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "responses": responses }))
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn outlook_moves_twenty_per_batch_and_matches_each_answer() {
        let mock = MockServer::start().await;
        // 25 moves: one batch of 20, one of 5.
        Mock::given(method("POST"))
            .and(path("/v1.0/$batch"))
            .respond_with(GraphBatch)
            .expect(2)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("MICROSOFT_GRAPH_BASE", mock.uri()) };
        let mut ids: Vec<String> = (0..25).map(|i| format!("m{i}")).collect();
        ids[3] = "gone".into();
        ids[7] = "bad".into();
        let results = outlook().move_many("tok", &ids, true).await;
        unsafe { std::env::remove_var("MICROSOFT_GRAPH_BASE") };

        assert_eq!(results.len(), 25);
        // Matched by request id despite the reversed answers.
        let first = results[0].as_ref().unwrap_or_else(|e| panic!("m0: {e}"));
        assert_eq!(first.new_id.as_deref(), Some("new-0"));
        let in_second_batch = results[24].as_ref().unwrap_or_else(|e| panic!("m24: {e}"));
        assert_eq!(in_second_batch.new_id.as_deref(), Some("new-4"));
        // Already gone from Outlook: nothing left to trash, so done.
        assert_eq!(
            results[3].as_ref().unwrap_or_else(|e| panic!("gone: {e}")),
            &TrashMoved::default()
        );
        assert!(results[7].is_err(), "a refused move is reported");
    }
}
