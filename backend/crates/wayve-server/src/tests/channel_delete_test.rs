// Deleting a channel (chat/channel_settings.rs delete_channel): only a channel
// admin may, and it takes everything with it for everyone: members, messages,
// attachment rows, and the attachment files in storage, which the database
// cascade alone would leave behind.
#[cfg(test)]
mod tests {
    use crate::chat::handler::delete_channel;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    struct Member {
        id: i32,
        email: String,
    }

    async fn user(pool: &PgPool) -> Member {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        Member { id, email }
    }

    /// A channel created by `members[0]`, with each member at the given role.
    async fn channel(pool: &PgPool, members: &[(&Member, &str)]) -> i32 {
        let channel_id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility) VALUES ('doomed', $1, 'private') RETURNING id",
        )
        .bind(members[0].0.id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create channel: {e}"));
        for (m, role) in members {
            sqlx::query(
                "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)",
            )
            .bind(channel_id)
            .bind(m.id)
            .bind(*role)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("add channel member: {e}"));
        }
        channel_id
    }

    async fn delete(pool: &PgPool, who: &Member, channel_id: i32) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(delete_channel),
        )
        .await;
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/chat/channels/{channel_id}"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(who.id, &who.email)),
            ))
            .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    async fn count(pool: &PgPool, sql: &str, channel_id: i32) -> i64 {
        sqlx::query_scalar(sql)
            .bind(channel_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("count: {e}"))
    }

    async fn exists(pool: &PgPool, channel_id: i32) -> bool {
        count(
            pool,
            "SELECT COUNT(*) FROM channels WHERE id = $1",
            channel_id,
        )
        .await
            > 0
    }

    async fn cleanup(pool: &PgPool, members: &[&Member]) {
        for m in members {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(m.id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_admin_deletes_the_channel_and_everything_in_it() {
        let pool = test_pool().await;
        let admin = user(&pool).await;
        let member = user(&pool).await;
        let channel_id = channel(&pool, &[(&admin, "admin"), (&member, "user")]).await;

        // A message with an attachment whose file is in storage.
        let message_id: i32 = sqlx::query_scalar(
            "INSERT INTO channel_messages (channel_id, sender_id, content_encrypted, content_iv) \
             VALUES ($1, $2, 'ct', 'iv') RETURNING id",
        )
        .bind(channel_id)
        .bind(member.id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("message: {e}"));
        let file = crate::storage::stored_path(&format!(
            "chat-delete-test-{}.bin",
            random_email().replace(['@', '.'], "-")
        ));
        crate::storage::put(&file, b"secret".to_vec())
            .await
            .unwrap_or_else(|e| panic!("store file: {e}"));
        sqlx::query(
            "INSERT INTO chat_attachments \
               (channel_message_id, uploader_id, filename, mime_type, size, file_path, file_iv, e2e) \
             VALUES ($1, $2, 'a.bin', 'application/octet-stream', 6, $3, 'iv', true)",
        )
        .bind(message_id)
        .bind(member.id)
        .bind(&file)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("attachment: {e}"));

        assert_eq!(delete(&pool, &admin, channel_id).await, StatusCode::OK);

        assert!(!exists(&pool, channel_id).await);
        for sql in [
            "SELECT COUNT(*) FROM channel_members WHERE channel_id = $1",
            "SELECT COUNT(*) FROM channel_messages WHERE channel_id = $1",
        ] {
            assert_eq!(count(&pool, sql, channel_id).await, 0, "{sql}");
        }
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM chat_attachments WHERE channel_message_id = $1",
                message_id
            )
            .await,
            0
        );
        // The file goes too, not just its row.
        assert!(
            crate::storage::get(&file).await.is_err(),
            "attachment file left behind"
        );

        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_logs WHERE action = 'channel_deleted' \
             AND resource_id = $1 AND actor_user_id = $2",
        )
        .bind(channel_id.to_string())
        .bind(admin.id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"));
        assert_eq!(audited, 1);

        cleanup(&pool, &[&admin, &member]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn only_a_channel_admin_may_delete_it() {
        let pool = test_pool().await;
        let admin = user(&pool).await;
        let member = user(&pool).await;
        let stranger = user(&pool).await;
        let channel_id = channel(&pool, &[(&admin, "admin"), (&member, "user")]).await;

        assert_eq!(
            delete(&pool, &member, channel_id).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            delete(&pool, &stranger, channel_id).await,
            StatusCode::FORBIDDEN
        );
        assert!(
            exists(&pool, channel_id).await,
            "a refused delete removed it"
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM channel_members WHERE channel_id = $1",
                channel_id
            )
            .await,
            2
        );

        // Gone is gone: deleting again is a 404, not a 500.
        assert_eq!(delete(&pool, &admin, channel_id).await, StatusCode::OK);
        assert_eq!(
            delete(&pool, &admin, channel_id).await,
            StatusCode::NOT_FOUND
        );

        cleanup(&pool, &[&admin, &member, &stranger]).await;
    }
}
