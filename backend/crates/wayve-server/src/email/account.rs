use crate::email::provider::MailProvider;
use crate::models::account::Account;
use crate::prelude::*;
use moka::future::Cache as MokaCache;
use sqlx::QueryBuilder;
use std::time::Duration;
use tracing::{error, instrument};

const EMAIL_ACCOUNT_CACHE_TTL_SECS: u64 = 60;
const EMAIL_ACCOUNT_CACHE_MAX_CAPACITY: u64 = 10_000;
const USER_ACCOUNT_LIST_CACHE_TTL_SECS: u64 = 60;
const USER_ACCOUNT_LIST_CACHE_MAX_CAPACITY: u64 = 10_000;

// Process-global pool, so code paths with no `&PgPool` in scope can still load
// connection settings. The IMAP `MailSender` impl needs this: its signature is
// fixed across providers and carries no pool.
static GLOBAL_POOL: std::sync::OnceLock<PgPool> = std::sync::OnceLock::new();

/// Call once during startup.
pub fn init_pool(pool: PgPool) {
    let _ = GLOBAL_POOL.set(pool);
}

/// Panics only if called before `init_pool`, which is a startup-ordering bug
/// rather than a runtime condition.
pub fn pool_handle() -> PgPool {
    GLOBAL_POOL
        .get()
        .cloned()
        .unwrap_or_else(|| panic!("email::account::pool_handle called before init_pool"))
}

static EMAIL_ACCOUNT_CACHE: Lazy<MokaCache<i32, EmailAccount>> = Lazy::new(|| {
    MokaCache::builder()
        .max_capacity(EMAIL_ACCOUNT_CACHE_MAX_CAPACITY)
        .time_to_live(Duration::from_secs(EMAIL_ACCOUNT_CACHE_TTL_SECS))
        .build()
});

static USER_ACCOUNT_LIST_CACHE: Lazy<MokaCache<i32, Vec<Account>>> = Lazy::new(|| {
    MokaCache::builder()
        .max_capacity(USER_ACCOUNT_LIST_CACHE_MAX_CAPACITY)
        .time_to_live(Duration::from_secs(USER_ACCOUNT_LIST_CACHE_TTL_SECS))
        .build()
});

#[derive(Clone)]
pub struct EmailAccount {
    pub id: i32,
    pub user_id: i32,
    pub email: String,
    pub provider: MailProvider,
    pub refresh_token: Option<String>,
    pub last_sync: Option<i64>,
    /// Timestamp of the most recent message received for this account, written
    /// by `repo::upsert_batch` / `upsert_one` on fresh inserts and seeded from
    /// `MAX(emails.created_at)` at startup. NULL on a new mailbox, which the
    /// sync worker's backoff ladder treats as cold.
    pub last_message_at: Option<chrono::NaiveDateTime>,
}

impl EmailAccount {
    pub fn usable_refresh_token(&self) -> Option<&str> {
        self.refresh_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

fn account_from_row(row: sqlx::postgres::PgRow) -> EmailAccount {
    let provider = row
        .try_get::<String, _>("provider")
        .map(|value| MailProvider::from_db(&value))
        .unwrap_or(MailProvider::Google);

    EmailAccount {
        id: row.get("id"),
        user_id: row.get("user_id"),
        email: row.try_get("email").unwrap_or_default(),
        provider,
        refresh_token: open_refresh_token(&row),
        last_sync: row.try_get("last_sync").ok(),
        // Some callers select without this column, so a missing one must read as
        // NULL rather than fail the whole row.
        last_message_at: row
            .try_get::<Option<chrono::NaiveDateTime>, _>("last_message_at")
            .ok()
            .flatten(),
    }
}

#[instrument(target = "db", skip(pool), fields(account_id, user_id))]
pub async fn load_email_account_for_user(
    pool: &PgPool,
    account_id: i32,
    user_id: i32,
) -> Result<Option<EmailAccount>> {
    if let Some(account) = EMAIL_ACCOUNT_CACHE.get(&account_id).await {
        return Ok((account.user_id == user_id).then_some(account));
    }

    let row = sqlx::query(
        "SELECT id, user_id, email, provider, refresh_token_iv, refresh_token_encrypted, last_sync
         FROM email_accounts
         WHERE id = $1 AND user_id = $2",
    )
    .bind(account_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let account = row.map(account_from_row);
    if let Some(account) = &account {
        EMAIL_ACCOUNT_CACHE
            .insert(account.id, account.clone())
            .await;
    }

    Ok(account)
}

/// Like `load_email_account_for_user`, but also accepts shared-inbox members
/// with `can_reply = TRUE`, so teammates can reply from `support@`. The
/// shared-member path deliberately bypasses the cache: membership is an
/// authorization check that must be read fresh.
#[instrument(target = "db", skip(pool), fields(account_id, user_id))]
pub async fn load_email_account_for_send(
    pool: &PgPool,
    account_id: i32,
    user_id: i32,
) -> Result<Option<EmailAccount>> {
    if let Some(account) = load_email_account_for_user(pool, account_id, user_id).await? {
        return Ok(Some(account));
    }
    let row = sqlx::query(
        r#"
        SELECT a.id, a.user_id, a.email, a.provider, a.refresh_token_iv, a.refresh_token_encrypted, a.last_sync
          FROM email_accounts a
          JOIN shared_inbox_members m
            ON m.account_id = a.id
           AND m.user_id = $2
           AND m.can_reply = TRUE
         WHERE a.id = $1
        "#,
    )
    .bind(account_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(account_from_row))
}

/// Case-insensitive lookup by address, for the Gmail push receiver, which knows
/// only the email. Uncached: pushes are infrequent and need fresh token state.
#[instrument(target = "db", skip(pool))]
pub async fn load_email_account_by_email(
    pool: &PgPool,
    email: &str,
) -> Result<Option<EmailAccount>> {
    let row = sqlx::query(
        "SELECT id, user_id, email, provider, refresh_token_iv, refresh_token_encrypted, last_sync, last_message_at
         FROM email_accounts
         WHERE lower(email) = lower($1) AND token_expiry IS NOT NULL
         ORDER BY id
         LIMIT 1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(account_from_row))
}

#[instrument(target = "db", skip(pool))]
pub async fn load_syncable_email_accounts(pool: &PgPool) -> Result<Vec<EmailAccount>> {
    let rows = sqlx::query(
        "SELECT id, user_id, email, provider, refresh_token_iv, refresh_token_encrypted, last_sync, last_message_at
         FROM email_accounts
         -- Set on every connect; rows inserted any other way are not mailboxes.
         WHERE token_expiry IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(account_from_row).collect())
}

#[instrument(target = "db", skip(pool), fields(user_id, account_id))]
pub async fn load_user_email_accounts_for_older_sync(
    pool: &PgPool,
    user_id: i32,
    account_id: Option<i32>,
) -> Result<Vec<EmailAccount>> {
    let mut qb = QueryBuilder::new(
        "SELECT id, user_id, email, provider, refresh_token_iv, refresh_token_encrypted, last_sync
         FROM email_accounts
         WHERE user_id = ",
    );
    qb.push_bind(user_id);

    if let Some(account_id) = account_id {
        qb.push(" AND id = ");
        qb.push_bind(account_id);
    }

    let rows = qb.build().fetch_all(pool).await?;
    Ok(rows.into_iter().map(account_from_row).collect())
}

#[instrument(target = "db", skip(pool), fields(user_id))]
pub async fn load_account_summaries_for_user(pool: &PgPool, user_id: i32) -> Result<Vec<Account>> {
    // `provider_unread_count` is authoritative and refreshed every sync tick.
    // The local COUNT is only a fallback, for the window between account-add and
    // first sync and for shared inboxes whose provider count isn't refreshed per
    // member. It excludes SPAM and DRAFT to match what Gmail's labels.get reports
    // for INBOX, and self-sent mail, which would otherwise inflate the badge.
    // For Gmail it counts only INBOX-labelled mail, as the inbox list does.
    let accounts = sqlx::query_as::<_, Account>(
        r#"
        SELECT
          a.id,
          a.email,
          a.display_name,
          COALESCE(
            a.provider_unread_count::BIGINT,
            COUNT(e.id) FILTER (
              WHERE e.is_read = false
                AND lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%'
                AND NOT ('SPAM' = ANY(e.labels))
                AND NOT ('DRAFT' = ANY(e.labels))
                AND (a.provider <> 'google' OR 'INBOX' = ANY(e.labels))
            )::BIGINT
          ) AS unread_count,
          a.is_shared,
          a.shared_label,
          (a.user_id = $1) AS is_owner
        FROM email_accounts a
        LEFT JOIN emails e ON e.account_id = a.id
        LEFT JOIN shared_inbox_members m
               ON m.account_id = a.id AND m.user_id = $1
        WHERE a.user_id = $1 OR m.user_id IS NOT NULL
        GROUP BY a.id, a.email
        ORDER BY a.is_shared, a.id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(accounts)
}

#[instrument(target = "cache", fields(account_id))]
pub async fn invalidate_email_account_cache(account_id: i32) {
    EMAIL_ACCOUNT_CACHE.invalidate(&account_id).await;
}

#[instrument(target = "cache", fields(user_id))]
pub async fn invalidate_user_account_list_cache(user_id: i32) {
    USER_ACCOUNT_LIST_CACHE.invalidate(&user_id).await;
}

pub struct ConnectedEmailAccount<'a> {
    pub email: &'a str,
    pub user_id: i32,
    pub provider: MailProvider,
    pub access_token: &'a str,
    pub refresh_token: Option<&'a str>,
    pub expires_in: i64,
}

/// Returns `Some(owner_user_id)` when `email` is already connected as a
/// non-shared mailbox under a different user. OAuth callbacks must check this
/// before insert: otherwise one user can connect another's mailbox and sync a
/// duplicate copy of every message. Shared inboxes are excluded, since
/// `shared_inbox_members` is the supported way to surface one mailbox to many.
pub async fn email_owned_by_other_user(
    pool: &PgPool,
    email: &str,
    requesting_user_id: i32,
) -> Result<Option<i32>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT user_id
        FROM email_accounts
        WHERE lower(email) = lower($1)
          AND COALESCE(is_shared, false) = false
          AND user_id <> $2
        LIMIT 1
        "#,
    )
    .bind(email)
    .bind(requesting_user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.get::<i32, _>("user_id")))
}

/// Whether `user_id` may attach the mailbox `authorized_email`. Every managed
/// account — organization, organization_admin, and platform_admin — may only
/// connect the mailbox matching the address it signs in to Fluxze with; only
/// personal accounts are unrestricted. Comparison is trimmed + case-insensitive.
///
/// A DB error propagates as `Err` so callers can fail closed on a check this
/// security-relevant. A missing user row yields `Ok(true)` — the connect flow
/// has already authenticated the caller, so a vanished row is not this gate's
/// concern.
pub async fn account_may_attach_mailbox(
    pool: &PgPool,
    user_id: i32,
    authorized_email: &str,
) -> Result<bool, sqlx::Error> {
    let Some(row) = sqlx::query("SELECT email, account_type FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(true);
    };

    let account_type: String = row.get("account_type");
    if account_type == "personal" {
        return Ok(true);
    }

    let login_email: String = row.get("email");
    Ok(login_email
        .trim()
        .eq_ignore_ascii_case(authorized_email.trim()))
}

/// Encrypts a mailbox token for the `*_token_iv` / `*_token_encrypted` column
/// pair. An empty token maps to `(None, None)` so the "keep the stored refresh
/// token" COALESCE in the writers leaves the stored pair alone.
pub fn seal_token(token: &str) -> Result<(Option<String>, Option<String>)> {
    if token.is_empty() {
        return Ok((None, None));
    }
    let (iv, ciphertext) = wayve_security::encryption::encrypt(token)?;
    Ok((Some(iv), Some(ciphertext)))
}

/// Decrypts a `*_token_iv` / `*_token_encrypted` pair. `None` when the pair is
/// NULL, empty, or fails to decrypt; callers treat that as "reconnect needed",
/// the same as a missing token.
pub fn open_token(iv: Option<String>, ciphertext: Option<String>) -> Option<String> {
    let (iv, ciphertext) = (iv?, ciphertext?);
    match wayve_security::encryption::decrypt(&iv, &ciphertext) {
        Ok(token) if !token.trim().is_empty() => Some(token),
        Ok(_) => None,
        Err(e) => {
            error!(target: "auth", error = %e, "mailbox token decrypt failed");
            None
        }
    }
}

/// The refresh token from a row that selected `refresh_token_iv` and
/// `refresh_token_encrypted`. A row from a LEFT JOIN with no account reads as
/// `None`.
pub fn open_refresh_token(row: &sqlx::postgres::PgRow) -> Option<String> {
    open_token(
        row.try_get("refresh_token_iv").ok().flatten(),
        row.try_get("refresh_token_encrypted").ok().flatten(),
    )
}

/// The access token from a row that selected `access_token_iv` and
/// `access_token_encrypted`.
pub fn open_access_token(row: &sqlx::postgres::PgRow) -> Option<String> {
    open_token(
        row.try_get("access_token_iv").ok().flatten(),
        row.try_get("access_token_encrypted").ok().flatten(),
    )
}

/// Moves tokens still in the legacy plaintext `access_token` / `refresh_token`
/// columns into the encrypted pairs and clears the plaintext. Every writer
/// clears the plaintext it supersedes, so any plaintext still present is the
/// newest copy (e.g. written by an older build after a rollback) and wins over
/// an existing encrypted pair. Migrated rows have NULL plaintext, so re-runs
/// touch nothing. Each UPDATE is guarded on the plaintext it read, so a write
/// racing the backfill is left for the next run rather than clobbered.
///
/// Runs at boot and again on every sync tick, which picks up rows a failed run
/// skipped and plaintext an older build writes during a deploy. A row whose
/// UPDATE fails is logged and skipped; an encryption failure (bad `AES_KEY`)
/// would fail every row alike, so it aborts the run.
#[instrument(target = "db", skip(pool))]
pub async fn backfill_token_encryption(pool: &PgPool) -> Result<u64> {
    let rows = sqlx::query(
        "SELECT id, access_token, refresh_token FROM email_accounts \
         WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;

    let mut moved = 0;
    for row in rows {
        let id: i32 = row.get("id");
        let access_token: Option<String> = row.get("access_token");
        let refresh_token: Option<String> = row.get("refresh_token");
        let (access_iv, access_ct) = seal_token(access_token.as_deref().unwrap_or(""))?;
        let (refresh_iv, refresh_ct) = seal_token(refresh_token.as_deref().unwrap_or(""))?;

        // A non-NULL plaintext access token marked the row as connected; carry
        // that over to `token_expiry`, which the loaders now filter on.
        let result = sqlx::query(
            "UPDATE email_accounts SET \
               access_token_iv = COALESCE($1, access_token_iv), \
               access_token_encrypted = COALESCE($2, access_token_encrypted), \
               refresh_token_iv = COALESCE($3, refresh_token_iv), \
               refresh_token_encrypted = COALESCE($4, refresh_token_encrypted), \
               token_expiry = CASE WHEN access_token IS NOT NULL \
                                   THEN COALESCE(token_expiry, NOW()) \
                                   ELSE token_expiry END, \
               access_token = NULL, \
               refresh_token = NULL \
             WHERE id = $5 \
               AND access_token IS NOT DISTINCT FROM $6 \
               AND refresh_token IS NOT DISTINCT FROM $7",
        )
        .bind(access_iv)
        .bind(access_ct)
        .bind(refresh_iv)
        .bind(refresh_ct)
        .bind(id)
        .bind(&access_token)
        .bind(&refresh_token)
        .execute(pool)
        .await;
        match result {
            Ok(done) if done.rows_affected() > 0 => {
                moved += 1;
                invalidate_email_account_cache(id).await;
            }
            Ok(_) => {}
            Err(e) => {
                error!(target: "db", account_id = id, error = ?e, "mailbox token backfill failed for row");
            }
        }
    }
    Ok(moved)
}

/// Stores a freshly minted access token.
#[instrument(target = "db", skip(pool, access_token))]
pub async fn store_access_token(pool: &PgPool, account_id: i32, access_token: &str) -> Result<()> {
    let (iv, ciphertext) = seal_token(access_token)?;
    sqlx::query(
        "UPDATE email_accounts \
         SET access_token_iv = $1, access_token_encrypted = $2, access_token = NULL \
         WHERE id = $3",
    )
    .bind(iv)
    .bind(ciphertext)
    .bind(account_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[instrument(
    target = "db",
    skip(pool, account),
    fields(user_id = account.user_id, provider = account.provider.as_db(), email = account.email)
)]
pub async fn upsert_connected_email_account(
    pool: &PgPool,
    account: ConnectedEmailAccount<'_>,
) -> Result<i32> {
    let expiry = (chrono::Utc::now() + chrono::Duration::seconds(account.expires_in)).naive_utc();
    let refresh_token = account.refresh_token.unwrap_or("");
    let (access_iv, access_ct) = seal_token(account.access_token)?;
    let (refresh_iv, refresh_ct) = seal_token(refresh_token)?;

    // `last_sync` is the worker's incremental cursor, and NULL means "crawl the
    // whole mailbox". Seeding it to NOW keeps the first tick to a bounded
    // `after:` query; the on-connect `sync_account_recent` has already pulled
    // recent mail, so nothing is lost. ON CONFLICT preserves it on reconnect.
    // A reconnect without a new refresh token keeps the stored one, including
    // a not-yet-backfilled plaintext one (the next sync tick's backfill seals
    // it into the pair); any plaintext a new token supersedes
    // is cleared. `token_expiry` is always set here; the loaders read it as
    // "connected".
    let row = sqlx::query(
        r#"
        INSERT INTO email_accounts
          (email, user_id, token_expiry, is_active, provider, last_sync,
           access_token_iv, access_token_encrypted, refresh_token_iv, refresh_token_encrypted)
        VALUES ($1, $2, $3, true, $4, EXTRACT(EPOCH FROM NOW())::BIGINT, $5, $6, $7, $8)
        ON CONFLICT (user_id, email) DO UPDATE SET
          access_token = NULL,
          refresh_token = CASE WHEN EXCLUDED.refresh_token_encrypted IS NULL
                               THEN email_accounts.refresh_token END,
          access_token_iv = EXCLUDED.access_token_iv,
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          token_expiry = EXCLUDED.token_expiry,
          provider = EXCLUDED.provider,
          is_active = true,
          refresh_token_iv = COALESCE(EXCLUDED.refresh_token_iv, email_accounts.refresh_token_iv),
          refresh_token_encrypted = COALESCE(
            EXCLUDED.refresh_token_encrypted,
            email_accounts.refresh_token_encrypted
          )
        RETURNING id
        "#,
    )
    .bind(account.email)
    .bind(account.user_id)
    .bind(expiry)
    .bind(account.provider.as_db())
    .bind(access_iv)
    .bind(access_ct)
    .bind(refresh_iv)
    .bind(refresh_ct)
    .fetch_one(pool)
    .await?;

    let account_id = row.get("id");
    invalidate_email_account_cache(account_id).await;
    invalidate_user_account_list_cache(account.user_id).await;

    Ok(account_id)
}
