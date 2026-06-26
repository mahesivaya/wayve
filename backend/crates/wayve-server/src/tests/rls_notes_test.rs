//! Row-Level Security isolation tests for the `notes` table (phase 2 pilot).
//!
//! Proves the FORCE-RLS `notes_rls` policy (see infra/postgres/init.sql):
//!   * a user (`app.user_id`) sees ONLY their own notes
//!   * cross-user UPDATE / DELETE affect 0 rows
//!   * a connection with NO GUC sees 0 rows (deny-by-default)
//!   * `app.bypass = 'on'` sees everything
//!   * WITH CHECK rejects inserting a row owned by another user
//!
//! Requires the test DB to have init.sql applied (notes RLS enabled). The test
//! pins specific note ids in every assertion, so it is independent of any other
//! rows in a shared test database.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::{PgPool, Postgres, Transaction};

    /// Insert a note for `user_id` using the bypass GUC (test setup), return id.
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

    /// Begin a transaction scoped to `app.user_id = user_id`, dropped into the
    /// restricted role so RLS engages (mirrors db::apply_rls_user).
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

    /// Begin a transaction in the restricted role with no GUC set (or bypass).
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

        // 1. As user A: among the two seeded notes, sees only their own.
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

        // 2. As user A: cross-user UPDATE and DELETE affect zero rows.
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

        // 3. Restricted role, no GUC set: deny-by-default — sees neither note.
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

        // 4. Restricted role with bypass GUC: the policy's bypass clause sees both.
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

        // 5. WITH CHECK: as user A, inserting a row owned by B is rejected.
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
