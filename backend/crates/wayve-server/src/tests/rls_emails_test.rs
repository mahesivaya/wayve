//! RLS isolation tests for `emails` (phase 2). Proves the 3-way policy:
//! mailbox owner, wayve recipient, and shared-inbox member — plus
//! deny-by-default. Setup inserts run as the (superuser) test role, which
//! bypasses RLS; the assertions drop to `wayve_app` so the policy engages.

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

    async fn visible(tx: &mut Transaction<'_, Postgres>, gmail_id: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM emails WHERE gmail_id = $1")
            .bind(gmail_id)
            .fetch_one(&mut **tx)
            .await
            .unwrap_or_else(|e| panic!("count: {e}"))
    }

    #[tokio::test]
    async fn emails_rls_owner_recipient_shared() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let g_owner = format!("g-owner-{a}");
        let g_wayve = format!("g-wayve-{b}");

        // Seed as superuser (bypasses RLS).
        let acct: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'imap') RETURNING id",
        )
        .bind(format!("mbox-{a}@x.t"))
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("acct: {e}"));
        sqlx::query("INSERT INTO emails (gmail_id, account_id, source) VALUES ($1, $2, 'imap')")
            .bind(&g_owner)
            .bind(acct)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("email1: {e}"));
        sqlx::query(
            "INSERT INTO emails (gmail_id, source, recipient_user_id) VALUES ($1, 'wayve', $2)",
        )
        .bind(&g_wayve)
        .bind(b)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("email2: {e}"));

        {
            let mut tx = begin_as_user(&pool, a).await;
            assert_eq!(
                visible(&mut tx, &g_owner).await,
                1,
                "A sees own-account email"
            );
            assert_eq!(
                visible(&mut tx, &g_wayve).await,
                0,
                "A must not see B's wayve email"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = begin_as_user(&pool, b).await;
            assert_eq!(
                visible(&mut tx, &g_wayve).await,
                1,
                "B sees their wayve email"
            );
            assert_eq!(
                visible(&mut tx, &g_owner).await,
                0,
                "B must not see A's account email pre-share"
            );
            let _ = tx.rollback().await;
        }
        // Sharing A's mailbox with B must grant B access to it on the next request.
        sqlx::query("INSERT INTO shared_inbox_members (account_id, user_id) VALUES ($1, $2)")
            .bind(acct)
            .bind(b)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("share: {e}"));
        {
            let mut tx = begin_as_user(&pool, b).await;
            assert_eq!(
                visible(&mut tx, &g_owner).await,
                1,
                "shared-inbox member sees the mail"
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
            assert_eq!(visible(&mut tx, &g_owner).await, 0, "no GUC sees nothing");
            let _ = tx.rollback().await;
        }

        let _ = sqlx::query("DELETE FROM emails WHERE gmail_id = ANY($1)")
            .bind(&[g_owner, g_wayve][..])
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM email_accounts WHERE id = $1")
            .bind(acct)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(&[a, b][..])
            .execute(&pool)
            .await;
    }
}
