// The DM details panel: the peer profile is limited to people the caller can
// already see (or has a DM with), and the files list returns only this
// conversation's messages that carry attachments, newest first, as envelopes.
#[cfg(test)]
mod tests {
    use crate::chat::dm_details::{get_dm_files, get_peer_profile};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::Value;
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

    /// A DM whose stored content is `content` under the server at-rest layer.
    async fn insert_dm(pool: &PgPool, from: i32, to: i32, content: &str) -> i32 {
        let (iv, ct) =
            wayve_security::encryption::encrypt(content).unwrap_or_else(|e| panic!("encrypt: {e}"));
        sqlx::query_scalar(
            "INSERT INTO messages (sender_id, receiver_id, content_encrypted, content_iv) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(from)
        .bind(to)
        .bind(ct)
        .bind(iv)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert dm: {e}"))
    }

    async fn attach(pool: &PgPool, message_id: i32, uploader: i32) {
        sqlx::query(
            "INSERT INTO chat_attachments (message_id, uploader_id, filename, size, file_path) \
             VALUES ($1, $2, 'blob', 10, 'chat/test-blob')",
        )
        .bind(message_id)
        .bind(uploader)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert attachment: {e}"));
    }

    async fn cleanup(pool: &PgPool, users: &[i32], channels: &[i32]) {
        for id in channels {
            let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in users {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    /// GET `$uri` (optionally as `$token`) and return the status and JSON body.
    macro_rules! get_json {
        ($app:expr, $uri:expr, $token:expr) => {{
            let mut req = actix_test::TestRequest::get().uri(&$uri);
            let token: Option<&str> = $token;
            if let Some(token) = token {
                req = req.insert_header(("Authorization", format!("Bearer {token}")));
            }
            let resp = actix_test::call_service(&$app, req.to_request()).await;
            let status = resp.status();
            let body = actix_test::read_body(resp).await;
            let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            (status, json)
        }};
    }

    fn ids(body: &Value) -> Vec<i64> {
        body.as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r["message_id"].as_i64())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn files_lists_only_this_conversations_attachments() {
        ensure_aes_key();
        let pool = test_pool().await;
        let me = insert_local_user(&pool, &random_email(), "pw").await;
        let peer = insert_local_user(&pool, &random_email(), "pw").await;
        let other = insert_local_user(&pool, &random_email(), "pw").await;

        let _text_only = insert_dm(&pool, me, peer, "envelope-0").await;
        let first = insert_dm(&pool, me, peer, "envelope-1").await;
        attach(&pool, first, me).await;
        let second = insert_dm(&pool, peer, me, "envelope-2").await;
        attach(&pool, second, peer).await;
        // Same caller, different conversation: must not leak into this list.
        let elsewhere = insert_dm(&pool, me, other, "envelope-x").await;
        attach(&pool, elsewhere, me).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_dm_files),
        )
        .await;
        let token = jwt_for(me, "ignored@example.com");
        let uri = format!("/chat/direct-messages/{peer}/files");

        let (status, _) = get_json!(app, &uri, None);
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = get_json!(app, &uri, Some(&token));
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ids(&body), vec![i64::from(second), i64::from(first)]);
        // The storage layer is stripped; the client envelope comes back.
        assert_eq!(body[0]["content"], "envelope-2");
        assert_eq!(body[0]["sender_id"], peer);

        // Paging: older than the newest, and a page size of one.
        let (_, body) = get_json!(app, &format!("{uri}?before_id={second}"), Some(&token));
        assert_eq!(ids(&body), vec![i64::from(first)]);
        let (_, body) = get_json!(app, &format!("{uri}?limit=1"), Some(&token));
        assert_eq!(ids(&body), vec![i64::from(second)]);

        // A third party asking about the same peer sees none of it.
        let outsider = jwt_for(other, "ignored@example.com");
        let (status, body) = get_json!(app, &uri, Some(&outsider));
        assert_eq!(status, StatusCode::OK);
        assert!(ids(&body).is_empty());

        cleanup(&pool, &[me, peer, other], &[]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn profile_is_limited_to_people_the_caller_can_see() {
        ensure_aes_key();
        let pool = test_pool().await;
        let me = insert_local_user(&pool, &random_email(), "pw").await;
        let peer = insert_local_user(&pool, &random_email(), "pw").await;
        let stranger = insert_local_user(&pool, &random_email(), "pw").await;

        sqlx::query("UPDATE users SET first_name = 'Ada', last_name = 'Lovelace', username = 'ada' WHERE id = $1")
            .bind(peer)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("name peer: {e}"));
        insert_dm(&pool, me, peer, "hello").await;
        let channel: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("shared-{me}"))
        .bind(me)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("channel: {e}"));
        sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(channel)
            .bind(me)
            .bind(peer)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("members: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_peer_profile),
        )
        .await;
        let token = jwt_for(me, "ignored@example.com");

        let (status, _) = get_json!(app, &format!("/chat/users/{peer}/profile"), None);
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = get_json!(app, &format!("/chat/users/{peer}/profile"), Some(&token));
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], peer);
        assert_eq!(body["first_name"], "Ada");
        assert_eq!(body["username"], "ada");
        assert_eq!(body["has_avatar"], false);
        assert_eq!(body["chat_status"], "active");
        assert_eq!(body["shared_channels"][0]["id"], channel);

        // A personal account with no shared channel or DM is not visible.
        let (status, _) = get_json!(
            app,
            &format!("/chat/users/{stranger}/profile"),
            Some(&token)
        );
        assert_eq!(status, StatusCode::NOT_FOUND);

        cleanup(&pool, &[me, peer, stranger], &[channel]).await;
    }
}
