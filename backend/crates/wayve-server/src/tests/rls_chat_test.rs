//! RLS isolation tests for chat (phase 2): DM participants + channel
//! membership. Setup inserts run as the (superuser) test role; assertions drop
//! to `wayve_app` so the participant policies engage.

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

    #[tokio::test]
    async fn chat_rls_dm_and_channel_membership() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let c = insert_local_user(&pool, &random_email(), "pw").await;

        // Seed as superuser (bypasses RLS).
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

        // DM: both participants see it; an outsider does not.
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

        // Channel message: a member sees it; a non-member does not.
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

        // Deny-by-default: restricted role, no GUC.
        {
            let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
            sqlx::query("SET LOCAL ROLE wayve_app")
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("role: {e}"));
            assert_eq!(count(&mut tx, CM, cm).await, 0, "no GUC sees nothing");
            let _ = tx.rollback().await;
        }

        // Cleanup (superuser).
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
}
