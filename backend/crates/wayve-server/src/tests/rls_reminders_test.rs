//! Row-Level Security isolation for the `reminders` table: a user reads and
//! writes only their own reminders, a restricted connection with no GUC set
//! sees nothing, and only `app.bypass` sees everything. The policy is generated
//! by the batch-2 RLS block in infra/postgres/init.sql, which the test database
//! must have applied.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::{PgPool, Postgres, Transaction};

    async fn seed_reminder(pool: &PgPool, user_id: i32, title: &str) -> i32 {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.bypass', 'on', true)")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("bypass: {e}"));
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO reminders (user_id, title, remind_at)
             VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING id",
        )
        .bind(user_id)
        .bind(title)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("seed reminder: {e}"));
        tx.commit().await.unwrap_or_else(|e| panic!("commit: {e}"));
        id
    }

    async fn begin_as_user(pool: &PgPool, user_id: i32) -> Transaction<'_, Postgres> {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.user_id', $1, true)")
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("set guc: {e}"));
        sqlx::query("SET LOCAL ROLE wayve_app")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("set role: {e}"));
        tx
    }

    async fn begin_restricted(pool: &PgPool) -> Transaction<'_, Postgres> {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SET LOCAL ROLE wayve_app")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("set role: {e}"));
        tx
    }

    async fn cleanup(pool: &PgPool, reminder_ids: &[i32], user_ids: &[i32]) {
        if let Ok(mut tx) = pool.begin().await {
            let _ = sqlx::query("SELECT set_config('app.bypass', 'on', true)")
                .execute(&mut *tx)
                .await;
            let _ = sqlx::query("DELETE FROM reminders WHERE id = ANY($1)")
                .bind(reminder_ids)
                .execute(&mut *tx)
                .await;
            let _ = tx.commit().await;
        }
        for uid in user_ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(pool)
                .await;
        }
    }

    #[tokio::test]
    async fn reminders_rls_enforces_per_user_isolation() {
        let pool = test_pool().await;
        let user_a = insert_local_user(&pool, &random_email(), "pw").await;
        let user_b = insert_local_user(&pool, &random_email(), "pw").await;
        let rem_a = seed_reminder(&pool, user_a, "A's reminder").await;
        let rem_b = seed_reminder(&pool, user_b, "B's reminder").await;
        let ids = [rem_a, rem_b];

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let visible: Vec<i32> =
                sqlx::query_scalar("SELECT id FROM reminders WHERE id = ANY($1) ORDER BY id")
                    .bind(&ids[..])
                    .fetch_all(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("select: {e}"));
            assert_eq!(
                visible,
                vec![rem_a],
                "user A must see only their own reminder"
            );
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let deleted = sqlx::query("DELETE FROM reminders WHERE id = $1")
                .bind(rem_b)
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("delete: {e}"))
                .rows_affected();
            assert_eq!(deleted, 0, "user A must not delete B's reminder");
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_restricted(&pool).await;
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reminders WHERE id = ANY($1)")
                .bind(&ids[..])
                .fetch_one(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
            assert_eq!(
                n, 0,
                "a restricted connection with no GUC must see no reminders"
            );
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let res = sqlx::query(
                "INSERT INTO reminders (user_id, title, remind_at)
                 VALUES ($1, 'spoof', NOW())",
            )
            .bind(user_b)
            .execute(&mut *tx)
            .await;
            assert!(
                res.is_err(),
                "WITH CHECK must reject inserting a reminder owned by another user"
            );
            let _ = tx.rollback().await;
        }

        cleanup(&pool, &ids, &[user_a, user_b]).await;
    }
}
