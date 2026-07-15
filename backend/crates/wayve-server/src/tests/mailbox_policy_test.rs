//! Mailbox-match policy: a managed account (organization, organization_admin,
//! or platform_admin) may only attach the mailbox matching the address it signs
//! in to Fluxze with; only personal accounts are unrestricted. Guards the shared
//! helper that every connect path (Gmail, Outlook, IMAP) calls.

#[cfg(test)]
mod tests {
    use crate::email::account::account_may_attach_mailbox;
    use crate::test_support::{insert_local_user, random_email, test_pool};

    async fn set_account_type(pool: &sqlx::PgPool, user_id: i32, account_type: &str) {
        sqlx::query("UPDATE users SET account_type = $1 WHERE id = $2")
            .bind(account_type)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set account_type: {e}"));
    }

    #[tokio::test]
    async fn managed_account_only_attaches_matching_mailbox() {
        let pool = test_pool().await;
        let login = random_email();
        let user = insert_local_user(&pool, &login, "pw").await;
        set_account_type(&pool, user, "organization").await;

        let check = |email: String| {
            let pool = pool.clone();
            async move {
                account_may_attach_mailbox(&pool, user, &email)
                    .await
                    .unwrap_or_else(|e| panic!("policy check: {e}"))
            }
        };

        assert!(check(login.clone()).await, "own login address is allowed");
        assert!(
            check(login.to_uppercase()).await,
            "match is case-insensitive"
        );
        assert!(
            check(format!("  {login}  ")).await,
            "surrounding whitespace is trimmed"
        );

        // Every managed account type is restricted to its own login address.
        for account_type in ["organization", "organization_admin", "platform_admin"] {
            set_account_type(&pool, user, account_type).await;
            assert!(
                check(login.clone()).await,
                "{account_type}: own address is allowed"
            );
            assert!(
                !check("outsider@example.com".to_string()).await,
                "{account_type}: a different address is rejected"
            );
        }

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn personal_account_is_unrestricted() {
        let pool = test_pool().await;
        let user = insert_local_user(&pool, &random_email(), "pw").await;
        // insert_local_user leaves account_type at its 'personal' default.

        let allowed = account_may_attach_mailbox(&pool, user, "any-other@example.com")
            .await
            .unwrap_or_else(|e| panic!("policy check: {e}"));
        assert!(allowed, "a personal account may connect any mailbox");

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }
}
