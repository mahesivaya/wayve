//! Mailbox OAuth tokens live only in the encrypted `*_token_iv` /
//! `*_token_encrypted` pairs. Every token writer sets the pair and leaves the
//! legacy plaintext columns NULL, a write that carries no new refresh token
//! keeps the stored one, the startup backfill moves legacy plaintext into the
//! pairs, and the account loaders decrypt what they read.

#[cfg(test)]
mod tests {
    use crate::email::account::{
        ConnectedEmailAccount, backfill_token_encryption, load_email_account_for_user,
        load_syncable_email_accounts, store_access_token, upsert_connected_email_account,
    };
    use crate::email::imap::encode_secret;
    use crate::email::provider::{MailProvider, RefreshedEmailToken, persist_refreshed_token};
    use crate::test_support::{delete_user, insert_local_user, random_email, test_pool};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::{decrypt, encrypt};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn set_key() {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("AES_KEY", HEX64_TEST_KEY) };
    }

    #[derive(Debug, PartialEq)]
    struct Stored {
        access: Option<String>,
        refresh: Option<String>,
        plaintext_cleared: bool,
        connected: bool,
    }

    /// Decrypts the stored pairs (`None` where a pair is NULL) and reports
    /// whether the plaintext columns are NULL and `token_expiry` is set.
    async fn stored(pool: &PgPool, account_id: i32) -> Stored {
        let row = sqlx::query(
            "SELECT access_token_iv, access_token_encrypted, \
                    refresh_token_iv, refresh_token_encrypted, \
                    access_token IS NULL AND refresh_token IS NULL AS plaintext_cleared, \
                    token_expiry IS NOT NULL AS connected \
             FROM email_accounts WHERE id = $1",
        )
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|err| panic!("load account: {err}"));
        let open = |iv: &str, ct: &str| {
            let iv: Option<String> = row.get(iv);
            let ct: Option<String> = row.get(ct);
            match (iv, ct) {
                (Some(iv), Some(ct)) => {
                    Some(decrypt(&iv, &ct).unwrap_or_else(|err| panic!("decrypt: {err}")))
                }
                (None, None) => None,
                other => panic!("iv/ciphertext out of step: {other:?}"),
            }
        };
        Stored {
            access: open("access_token_iv", "access_token_encrypted"),
            refresh: open("refresh_token_iv", "refresh_token_encrypted"),
            plaintext_cleared: row.get("plaintext_cleared"),
            connected: row.get("connected"),
        }
    }

    fn tokens(access: Option<&str>, refresh: Option<&str>) -> Stored {
        Stored {
            access: access.map(str::to_string),
            refresh: refresh.map(str::to_string),
            plaintext_cleared: true,
            connected: true,
        }
    }

    /// A row as the pre-encryption build wrote it: plaintext tokens only.
    async fn insert_legacy(
        pool: &PgPool,
        user_id: i32,
        provider: &str,
        access: Option<&str>,
        refresh: Option<&str>,
    ) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, access_token, refresh_token) \
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(random_email())
        .bind(user_id)
        .bind(provider)
        .bind(access)
        .bind(refresh)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|err| panic!("insert legacy row: {err}"))
    }

    async fn backfill(pool: &PgPool) {
        backfill_token_encryption(pool)
            .await
            .unwrap_or_else(|err| panic!("backfill: {err}"));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn every_token_write_sets_only_the_encrypted_pair() {
        set_key();
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw-unused").await;
        let mailbox = random_email();
        let connect = |access: &'static str, refresh: Option<&'static str>| ConnectedEmailAccount {
            email: &mailbox,
            user_id,
            provider: MailProvider::Google,
            access_token: access,
            refresh_token: refresh,
            expires_in: 3600,
        };

        let account_id =
            upsert_connected_email_account(&pool, connect("access-1", Some("refresh-1")))
                .await
                .unwrap_or_else(|err| panic!("connect: {err}"));
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("access-1"), Some("refresh-1"))
        );

        let row = sqlx::query("SELECT access_token_encrypted FROM email_accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|err| panic!("load ciphertext: {err}"));
        let ciphertext: String = row.get("access_token_encrypted");
        assert!(
            !ciphertext.contains("access-1"),
            "ciphertext must not hold the token"
        );

        // Google omits the refresh token on reconnect; the stored one survives.
        let same_id = upsert_connected_email_account(&pool, connect("access-2", None))
            .await
            .unwrap_or_else(|err| panic!("reconnect: {err}"));
        assert_eq!(same_id, account_id);
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("access-2"), Some("refresh-1"))
        );

        let refreshed = RefreshedEmailToken {
            access_token: "access-3".into(),
            refresh_token: None,
        };
        persist_refreshed_token(&pool, account_id, &refreshed)
            .await
            .unwrap_or_else(|err| panic!("persist refresh: {err}"));
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("access-3"), Some("refresh-1"))
        );

        let rotated = RefreshedEmailToken {
            access_token: "access-4".into(),
            refresh_token: Some("refresh-2".into()),
        };
        persist_refreshed_token(&pool, account_id, &rotated)
            .await
            .unwrap_or_else(|err| panic!("persist rotation: {err}"));
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("access-4"), Some("refresh-2"))
        );

        store_access_token(&pool, account_id, "access-5")
            .await
            .unwrap_or_else(|err| panic!("store access: {err}"));
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("access-5"), Some("refresh-2"))
        );

        // The loaders hand back the decrypted refresh token.
        let account = load_email_account_for_user(&pool, account_id, user_id)
            .await
            .unwrap_or_else(|err| panic!("load account: {err}"))
            .unwrap_or_else(|| panic!("account not found"));
        assert_eq!(account.usable_refresh_token(), Some("refresh-2"));

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn backfill_moves_legacy_plaintext_into_the_encrypted_pair() {
        set_key();
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw-unused").await;
        let account_id = insert_legacy(
            &pool,
            user_id,
            "google",
            Some("old-access"),
            Some("old-refresh"),
        )
        .await;

        backfill(&pool).await;
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("old-access"), Some("old-refresh"))
        );

        // A migrated row is still picked up by the sync worker, decrypted.
        let syncable = load_syncable_email_accounts(&pool)
            .await
            .unwrap_or_else(|err| panic!("load syncable: {err}"));
        let account = syncable
            .iter()
            .find(|a| a.id == account_id)
            .unwrap_or_else(|| panic!("migrated row is not syncable"));
        assert_eq!(account.usable_refresh_token(), Some("old-refresh"));

        // A second run leaves the migrated row alone.
        backfill(&pool).await;
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("old-access"), Some("old-refresh"))
        );

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn backfill_prefers_plaintext_over_a_stale_encrypted_pair() {
        set_key();
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw-unused").await;
        // An older build after a rollback writes plaintext without touching the
        // pair this build had already written.
        let account_id = insert_legacy(
            &pool,
            user_id,
            "google",
            Some("new-access"),
            Some("new-refresh"),
        )
        .await;
        let (iv, ciphertext) =
            encrypt("stale-refresh").unwrap_or_else(|err| panic!("encrypt: {err}"));
        sqlx::query(
            "UPDATE email_accounts \
             SET refresh_token_iv = $1, refresh_token_encrypted = $2 WHERE id = $3",
        )
        .bind(iv)
        .bind(ciphertext)
        .bind(account_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|err| panic!("seed stale pair: {err}"));

        backfill(&pool).await;
        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("new-access"), Some("new-refresh"))
        );

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reconnect_keeps_a_not_yet_backfilled_refresh_token() {
        set_key();
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw-unused").await;
        let mailbox = random_email();
        let account_id: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, access_token, refresh_token) \
             VALUES ($1, $2, 'google', 'old-access', 'legacy-refresh') RETURNING id",
        )
        .bind(&mailbox)
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|err| panic!("insert legacy row: {err}"));

        upsert_connected_email_account(
            &pool,
            ConnectedEmailAccount {
                email: &mailbox,
                user_id,
                provider: MailProvider::Google,
                access_token: "fresh-access",
                refresh_token: None,
                expires_in: 3600,
            },
        )
        .await
        .unwrap_or_else(|err| panic!("reconnect: {err}"));
        backfill(&pool).await;

        assert_eq!(
            stored(&pool, account_id).await,
            tokens(Some("fresh-access"), Some("legacy-refresh"))
        );

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn backfill_wraps_the_imap_password_blob() {
        set_key();
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw-unused").await;
        let blob = encode_secret("app-password").unwrap_or_else(|err| panic!("encode: {err}"));
        // IMAP rows store an empty access token and the password blob as the
        // refresh token.
        let account_id = insert_legacy(&pool, user_id, "imap", Some(""), Some(&blob)).await;

        backfill(&pool).await;
        assert_eq!(stored(&pool, account_id).await, tokens(None, Some(&blob)));

        delete_user(&pool, user_id).await;
    }
}
