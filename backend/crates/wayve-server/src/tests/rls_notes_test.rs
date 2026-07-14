//! Row-Level Security isolation for the `notes` table: a user reads and writes
//! only their own notes, a connection with no GUC set sees nothing at all, and
//! only `app.bypass` sees everything. The policy lives in infra/postgres/init.sql,
//! which the test database must have applied.
//!
//! Every assertion pins specific note ids, so these hold against a shared test
//! database that already contains other rows.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::{PgPool, Postgres, Transaction};

    /// Seeds a note through the bypass GUC, since setup must not be subject to
    /// the policy under test. Returns the note id.
    async fn seed_note(pool: &PgPool, user_id: i32, body: &str) -> i32 {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.bypass', 'on', true)")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("bypass: {e}"));
        let id: i32 =
            sqlx::query_scalar("INSERT INTO notes (user_id, content) VALUES ($1, $2) RETURNING id")
                .bind(user_id)
                .bind(body)
                .fetch_one(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("seed note: {e}"));
        tx.commit().await.unwrap_or_else(|e| panic!("commit: {e}"));
        id
    }

    /// Begins a transaction scoped to `app.user_id` in the restricted role, so
    /// that RLS engages exactly as it does in `db::apply_rls_user`.
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

    /// Begins a transaction in the restricted role with no GUC set at all.
    async fn begin_restricted(pool: &PgPool) -> Transaction<'_, Postgres> {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SET LOCAL ROLE wayve_app")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("set role: {e}"));
        tx
    }

    async fn cleanup(pool: &PgPool, note_ids: &[i32], user_ids: &[i32]) {
        if let Ok(mut tx) = pool.begin().await {
            let _ = sqlx::query("SELECT set_config('app.bypass', 'on', true)")
                .execute(&mut *tx)
                .await;
            let _ = sqlx::query("DELETE FROM notes WHERE id = ANY($1)")
                .bind(note_ids)
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
    async fn notes_rls_enforces_per_user_isolation() {
        let pool = test_pool().await;
        let user_a = insert_local_user(&pool, &random_email(), "pw").await;
        let user_b = insert_local_user(&pool, &random_email(), "pw").await;
        let note_a = seed_note(&pool, user_a, "A's note").await;
        let note_b = seed_note(&pool, user_b, "B's note").await;
        let ids = [note_a, note_b];

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let visible: Vec<i32> =
                sqlx::query_scalar("SELECT id FROM notes WHERE id = ANY($1) ORDER BY id")
                    .bind(&ids[..])
                    .fetch_all(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("select: {e}"));
            assert_eq!(visible, vec![note_a], "user A must see only their own note");
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let updated = sqlx::query("UPDATE notes SET content = 'hax' WHERE id = $1")
                .bind(note_b)
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("update: {e}"))
                .rows_affected();
            assert_eq!(updated, 0, "user A must not update B's note");
            let deleted = sqlx::query("DELETE FROM notes WHERE id = $1")
                .bind(note_b)
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("delete: {e}"))
                .rows_affected();
            assert_eq!(deleted, 0, "user A must not delete B's note");
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_restricted(&pool).await;
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes WHERE id = ANY($1)")
                .bind(&ids[..])
                .fetch_one(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
            assert_eq!(
                n, 0,
                "a restricted connection with no GUC must see no notes"
            );
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_restricted(&pool).await;
            sqlx::query("SELECT set_config('app.bypass', 'on', true)")
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("bypass: {e}"));
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes WHERE id = ANY($1)")
                .bind(&ids[..])
                .fetch_one(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
            assert_eq!(n, 2, "bypass must see all notes");
            let _ = tx.rollback().await;
        }

        {
            let mut tx = begin_as_user(&pool, user_a).await;
            let res = sqlx::query("INSERT INTO notes (user_id, content) VALUES ($1, 'spoof')")
                .bind(user_b)
                .execute(&mut *tx)
                .await;
            assert!(
                res.is_err(),
                "WITH CHECK must reject inserting a note owned by another user"
            );
            let _ = tx.rollback().await;
        }

        cleanup(&pool, &ids, &[user_a, user_b]).await;
    }
}
