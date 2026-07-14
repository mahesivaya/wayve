//! RLS isolation for chat: a DM is visible only to its two participants, and a
//! channel message only to that channel's members. Setup inserts run as the
//! superuser test role, while assertions drop to `wayve_app` so the policies
//! actually engage.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::{PgPool, Postgres, Transaction};

    async fn begin_as_user(pool: &PgPool, user_id: i32) -> Transaction<'_, Postgres> {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.user_id', $1, true)")
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("guc: {e}"));
        sqlx::query("SET LOCAL ROLE wayve_app")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("role: {e}"));
        tx
    }

    async fn count(tx: &mut Transaction<'_, Postgres>, sql: &str, id: i32) -> i64 {
        sqlx::query_scalar(sql)
            .bind(id)
            .fetch_one(&mut **tx)
            .await
            .unwrap_or_else(|e| panic!("count: {e}"))
    }

    const DM: &str = "SELECT count(*) FROM messages WHERE id = $1";
    const CM: &str = "SELECT count(*) FROM channel_messages WHERE id = $1";
    const ATT: &str = "SELECT count(*) FROM chat_attachments WHERE id = $1";

    async fn count_att(tx: &mut Transaction<'_, Postgres>, id: i64) -> i64 {
        sqlx::query_scalar(ATT)
            .bind(id)
            .fetch_one(&mut **tx)
            .await
            .unwrap_or_else(|e| panic!("count: {e}"))
    }

    #[tokio::test]
    async fn chat_rls_dm_and_channel_membership() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let c = insert_local_user(&pool, &random_email(), "pw").await;

        let dm: i32 = sqlx::query_scalar(
            "INSERT INTO messages (sender_id, receiver_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(a)
        .bind(b)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("dm: {e}"));
        let ch: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("ch-{a}"))
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("ch: {e}"));
        sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(ch)
            .bind(a)
            .bind(b)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("members: {e}"));
        let cm: i32 = sqlx::query_scalar(
            "INSERT INTO channel_messages (channel_id, sender_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(ch)
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("cm: {e}"));

        {
            let mut tx = begin_as_user(&pool, a).await;
            assert_eq!(count(&mut tx, DM, dm).await, 1, "A (sender) sees the DM");
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, b).await;
            assert_eq!(count(&mut tx, DM, dm).await, 1, "B (receiver) sees the DM");
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, c).await;
            assert_eq!(
                count(&mut tx, DM, dm).await,
                0,
                "C (outsider) must not see the DM"
            );
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_as_user(&pool, b).await;
            assert_eq!(
                count(&mut tx, CM, cm).await,
                1,
                "channel member sees the message"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, c).await;
            assert_eq!(
                count(&mut tx, CM, cm).await,
                0,
                "non-member must not see the message"
            );
            let _ = tx.rollback().await;
        }

        // Deny by default: the restricted role with no GUC set at all.
        {
            let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
            sqlx::query("SET LOCAL ROLE wayve_app")
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("role: {e}"));
            assert_eq!(count(&mut tx, CM, cm).await, 0, "no GUC sees nothing");
            let _ = tx.rollback().await;
        }

        let _ = sqlx::query("DELETE FROM channel_messages WHERE channel_id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM channel_members WHERE channel_id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(dm)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(&[a, b, c][..])
            .execute(&pool)
            .await;
    }

    /// An attachment on a channel message is readable by every member of that
    /// channel and by nobody else, while an upload not yet linked to a message
    /// stays visible only to its uploader.
    #[tokio::test]
    async fn chat_rls_channel_attachment_membership() {
        let pool = test_pool().await;
        let uploader = insert_local_user(&pool, &random_email(), "pw").await;
        let member = insert_local_user(&pool, &random_email(), "pw").await;
        let outsider = insert_local_user(&pool, &random_email(), "pw").await;

        // Seed as superuser (bypasses RLS).
        let ch: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("ch-att-{uploader}"))
        .bind(uploader)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("ch: {e}"));
        sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(ch)
            .bind(uploader)
            .bind(member)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("members: {e}"));
        let cm: i32 = sqlx::query_scalar(
            "INSERT INTO channel_messages (channel_id, sender_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(ch)
        .bind(uploader)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("cm: {e}"));

        // The unlinked attachment models the window between upload and send.
        let linked: i64 = sqlx::query_scalar(
            "INSERT INTO chat_attachments
                 (channel_message_id, uploader_id, filename, file_path, file_iv)
             VALUES ($1, $2, 'sent.pdf', '/uploads/sent', 'iv') RETURNING id",
        )
        .bind(cm)
        .bind(uploader)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("linked att: {e}"));
        let pending: i64 = sqlx::query_scalar(
            "INSERT INTO chat_attachments (uploader_id, filename, file_path, file_iv)
             VALUES ($1, 'pending.pdf', '/uploads/pending', 'iv') RETURNING id",
        )
        .bind(uploader)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("pending att: {e}"));

        {
            let mut tx = begin_as_user(&pool, uploader).await;
            assert_eq!(count_att(&mut tx, linked).await, 1, "uploader sees it");
            assert_eq!(
                count_att(&mut tx, pending).await,
                1,
                "uploader sees their own unsent upload"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, member).await;
            assert_eq!(
                count_att(&mut tx, linked).await,
                1,
                "channel member sees the attachment"
            );
            assert_eq!(
                count_att(&mut tx, pending).await,
                0,
                "an unsent upload is not visible to other members"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, outsider).await;
            assert_eq!(
                count_att(&mut tx, linked).await,
                0,
                "non-member must not see the channel attachment"
            );
            let _ = tx.rollback().await;
        }

        // Leaving the channel must revoke access on the very next request.
        sqlx::query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(ch)
            .bind(member)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("remove member: {e}"));
        {
            let mut tx = begin_as_user(&pool, member).await;
            assert_eq!(
                count_att(&mut tx, linked).await,
                0,
                "removed member loses access to the channel's attachments"
            );
            let _ = tx.rollback().await;
        }

        // An attachment may not point at a DM and a channel message at once.
        let dm: i32 = sqlx::query_scalar(
            "INSERT INTO messages (sender_id, receiver_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(uploader)
        .bind(outsider)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("dm: {e}"));
        let both = sqlx::query("UPDATE chat_attachments SET message_id = $1 WHERE id = $2")
            .bind(dm)
            .bind(linked)
            .execute(&pool)
            .await;
        assert!(
            both.is_err(),
            "linking one attachment to both a DM and a channel message must violate the CHECK"
        );

        let _ = sqlx::query("DELETE FROM chat_attachments WHERE id = ANY($1)")
            .bind(&[linked, pending][..])
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(dm)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM channel_messages WHERE channel_id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM channel_members WHERE channel_id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(ch)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(&[uploader, member, outsider][..])
            .execute(&pool)
            .await;
    }
}
