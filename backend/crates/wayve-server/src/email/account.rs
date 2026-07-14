use crate::email::provider::MailProvider;
use crate::models::account::Account;
use crate::prelude::*;
use moka::future::Cache as MokaCache;
use sqlx::QueryBuilder;
use std::time::Duration;
use tracing::instrument;

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
        refresh_token: row.try_get("refresh_token").ok().flatten(),
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
        "SELECT id, user_id, email, provider, refresh_token, last_sync
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
        SELECT a.id, a.user_id, a.email, a.provider, a.refresh_token, a.last_sync
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
        "SELECT id, user_id, email, provider, refresh_token, last_sync, last_message_at
         FROM email_accounts
         WHERE lower(email) = lower($1) AND access_token IS NOT NULL
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
        "SELECT id, user_id, email, provider, refresh_token, last_sync, last_message_at
         FROM email_accounts
         WHERE access_token IS NOT NULL",
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
        "SELECT id, user_id, email, provider, refresh_token, last_sync
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

    // `last_sync` is the worker's incremental cursor, and NULL means "crawl the
    // whole mailbox". Seeding it to NOW keeps the first tick to a bounded
    // `after:` query; the on-connect `sync_account_recent` has already pulled
    // recent mail, so nothing is lost. ON CONFLICT preserves it on reconnect.
    let row = sqlx::query(
        r#"
        INSERT INTO email_accounts
          (email, user_id, access_token, refresh_token, token_expiry, is_active, provider, last_sync)
        VALUES ($1, $2, $3, $4, $5, true, $6, EXTRACT(EPOCH FROM NOW())::BIGINT)
        ON CONFLICT (user_id, email) DO UPDATE SET
          access_token = EXCLUDED.access_token,
          token_expiry = EXCLUDED.token_expiry,
          provider = EXCLUDED.provider,
          is_active = true,
          refresh_token = COALESCE(
            NULLIF(EXCLUDED.refresh_token, ''),
            email_accounts.refresh_token
          )
        RETURNING id
        "#,
    )
    .bind(account.email)
    .bind(account.user_id)
    .bind(account.access_token)
    .bind(refresh_token)
    .bind(expiry)
    .bind(account.provider.as_db())
    .fetch_one(pool)
    .await?;

    let account_id = row.get("id");
    invalidate_email_account_cache(account_id).await;
    invalidate_user_account_list_cache(account.user_id).await;

    Ok(account_id)
}
