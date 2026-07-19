use crate::prelude::*;

use crate::email::account::load_syncable_email_accounts;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::provider::refresh_and_persist_email_token;

use serde_json::Value;
use tracing::{debug, error, info, instrument, warn};

/// `(msg_id, sender, receiver, subject, gmail_timestamp, is_read, labels)`. The
/// body is fetched later by body_worker. `labels` carries the message's full
/// Gmail `labelIds` so the sidebar category folders can filter locally.
pub type EmailHeader = (
    String,
    String,
    String,
    String,
    NaiveDateTime,
    bool,
    Vec<String>,
);

/// Stamps Gmail's authoritative INBOX unread count onto
/// `email_accounts.provider_unread_count`. Without it the sidebar badge would
/// only count locally-synced mail, so it would appear to climb as the user
/// paginates older mail. Best-effort: a stale count beats failing the sync.
pub async fn refresh_provider_unread_count(
    pool: &PgPool,
    account_id: i32,
    token: &str,
) -> anyhow::Result<()> {
    let url = format!(
        "{}/gmail/v1/users/me/labels/INBOX",
        crate::external::gmail_api_base()
    );
    let res = HTTP_CLIENT.get(&url).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        warn!(
            target: "worker",
            account_id,
            status = %res.status(),
            "labels.get returned non-success — skipping unread-count update"
        );
        return Ok(());
    }
    let body: Value = res.json().await?;
    let unread = body
        .get("messagesUnread")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0);
    // Clamp so a malformed payload can't overflow the INTEGER column.
    let unread_i32 = i32::try_from(unread.clamp(0, i32::MAX as i64)).unwrap_or(0);
    sqlx::query("UPDATE email_accounts SET provider_unread_count = $1 WHERE id = $2")
        .bind(unread_i32)
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn fetch_headers_only(token: &str, msg_id: &str) -> Result<EmailHeader> {
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject",
        crate::external::gmail_api_base(),
        msg_id
    );

    let resp = HTTP_CLIENT.get(&url).bearer_auth(token).send().await?;
    // A rate-limited or errored metadata fetch returns a JSON error object with
    // no payload/labelIds/internalDate. Parsing it would persist a bogus
    // "Unknown / (No Subject)" row for a real email, so reject non-2xx and error
    // bodies and leave the id for the next sync to retry.
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(anyhow::anyhow!(
            "gmail metadata fetch for {msg_id} failed: HTTP {status}"
        ));
    }
    let res: Value = resp.json().await?;
    if res.get("error").is_some() || !res["payload"].is_object() {
        return Err(anyhow::anyhow!(
            "gmail metadata fetch for {msg_id} returned no message body"
        ));
    }

    let (sender, receiver, subject) = extract_headers(&res);
    let gmail_timestamp = extract_gmail_timestamp(&res);
    let label_ids: Vec<String> = res["labelIds"]
        .as_array()
        .map(|labels| {
            labels
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let is_read = !label_ids.iter().any(|label| label == "UNREAD");
    Ok((
        msg_id.to_string(),
        sender,
        receiver,
        subject,
        gmail_timestamp,
        is_read,
        label_ids,
    ))
}

fn extract_gmail_timestamp(res: &Value) -> NaiveDateTime {
    res["internalDate"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|| chrono::Utc::now().naive_utc())
}

/// Runs the full per-account workload: token refresh, forward sync, backfill,
/// label backfill, and cache invalidation. Errors are logged and swallowed so
/// one bad account doesn't abort the rest of the tick.
pub async fn sync_one_account(pool: &PgPool, account: crate::email::account::EmailAccount) {
    let Some(refresh_token) = account.usable_refresh_token() else {
        warn!(target: "worker", account_id = account.id, "email account skipped: missing refresh token");
        return;
    };

    let token = match refresh_and_persist_email_token(
        pool,
        account.id,
        account.provider,
        refresh_token,
    )
    .await
    {
        Ok(token) => token,
        Err(e) => {
            warn!(target: "worker", account_id = account.id, provider = account.provider.as_db(), error = ?e, "token refresh failed; skipping account");
            return;
        }
    };

    let sync_result = account
        .provider
        .sync(pool, account.id, &token.access_token, account.last_sync)
        .await;

    if let Err(e) = sync_result {
        error!(target: "worker", account_id = account.id, provider = account.provider.as_db(), error = ?e, "email sync failed");
        return;
    }

    if let Err(err) = backfill_older(pool, account.id, &account.provider, &token.access_token).await
    {
        warn!(target: "worker", account_id = account.id, error = ?err, "backfill batch failed");
    }

    for label in [
        "SENT",
        "DRAFT",
        "SPAM",
        "TRASH",
        "IMPORTANT",
        "CATEGORY_PERSONAL",
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
    ] {
        if let Err(err) = backfill_label_older(pool, account.id, &token.access_token, label).await {
            warn!(target: "worker", account_id = account.id, label, error = ?err, "label backfill failed");
        }
    }

    // GitHub review/PR mail feeds the Reviews folder, which filters on the
    // sender. The label walk above can't reach it (no local rows to seed from),
    // so pull it by search instead — one window per tick until exhausted.
    if let Err(err) = backfill_query_older(
        pool,
        account.id,
        &token.access_token,
        "from:github.com",
        "%github.com%",
    )
    .await
    {
        warn!(target: "worker", account_id = account.id, error = ?err, "github backfill failed");
    }

    // Calendar rides the email cadence, reusing the token refreshed above.
    // Idempotent: import_upcoming_events upserts on (user_id, google_event_id).
    if account.provider == crate::email::provider::MailProvider::Google {
        match crate::scheduler::google_calendar::import_upcoming_events(
            pool,
            account.user_id,
            account.id,
            &token.access_token,
        )
        .await
        {
            Ok(n) => {
                debug!(target: "worker", account_id = account.id, count = n, "calendar import (tick)")
            }
            Err(e) => {
                warn!(target: "worker", account_id = account.id, error = %e, "calendar import (tick) failed")
            }
        }
    }

    // Fresh mail landed, so drop the profile caches rather than let the Storage
    // and Usage panel wait out their 30s/60s TTLs.
    crate::routes::user::invalidate_profile_cache(account.user_id).await;
    crate::email::profile::invalidate_me_cache(account.user_id).await;
}

/// Adaptive-backoff scheduler, called every 30s by the sync worker. Syncs only
/// accounts whose next-due time has elapsed, then reschedules them off the
/// `last_message_at` ladder. `schedule` is process memory, rebuilt on restart,
/// so a missing entry means "sync now" — the desired startup behaviour.
pub async fn sync_due_accounts(
    pool: &PgPool,
    schedule: &mut std::collections::HashMap<i32, std::time::Instant>,
) -> Result<()> {
    let accounts = load_syncable_email_accounts(pool).await?;
    let now = std::time::Instant::now();

    let (due, deferred): (Vec<_>, Vec<_>) = accounts
        .into_iter()
        .partition(|a| schedule.get(&a.id).map(|t| *t <= now).unwrap_or(true));

    info!(
        target: "worker",
        due = due.len(),
        deferred = deferred.len(),
        "sync_due_accounts"
    );

    // Drop entries for accounts that are no longer syncable (deleted, or OAuth
    // revoked); without this the schedule map grows unboundedly.
    let live_ids: std::collections::HashSet<i32> = due
        .iter()
        .map(|a| a.id)
        .chain(deferred.iter().map(|a| a.id))
        .collect();
    schedule.retain(|id, _| live_ids.contains(id));

    let mut handles = vec![];
    for account in due {
        let pool = pool.clone();
        let account_id = account.id;
        let pre_sync_last_message = account.last_message_at;
        handles.push(tokio::spawn(async move {
            sync_one_account(&pool, account).await;
            (account_id, pre_sync_last_message)
        }));
    }

    for h in handles {
        let Ok((account_id, pre)) = h.await else {
            continue;
        };
        let post: Option<NaiveDateTime> =
            sqlx::query_scalar("SELECT last_message_at FROM email_accounts WHERE id = $1")
                .bind(account_id)
                .fetch_one(pool)
                .await
                .unwrap_or(pre);

        // An advanced freshness stamp resets to the hot interval so the next
        // pickup is fast; otherwise the ladder steps up by absolute age.
        let new_mail_landed = match (pre, post) {
            (Some(p), Some(q)) => q > p,
            (None, Some(_)) => true,
            _ => false,
        };
        let interval = if new_mail_landed {
            INTERVAL_HOT
        } else {
            interval_for_age(post)
        };
        schedule.insert(account_id, std::time::Instant::now() + interval);
    }

    Ok(())
}

// Adaptive-backoff ladder: quiet accounts back off, busy ones stay hot. The
// brackets trade off noticing new mail quickly against hammering Gmail/Outlook
// for inboxes that haven't seen a message in a week.
const INTERVAL_HOT: std::time::Duration = std::time::Duration::from_secs(30);
const INTERVAL_WARM: std::time::Duration = std::time::Duration::from_secs(60);
const INTERVAL_COOL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const INTERVAL_COLD: std::time::Duration = std::time::Duration::from_secs(30 * 60);

fn interval_for_age(last_message_at: Option<NaiveDateTime>) -> std::time::Duration {
    let Some(ts) = last_message_at else {
        return INTERVAL_COLD;
    };
    let now = chrono::Utc::now().naive_utc();
    let age = now.signed_duration_since(ts);
    if age < chrono::Duration::hours(1) {
        INTERVAL_HOT
    } else if age < chrono::Duration::hours(24) {
        INTERVAL_WARM
    } else if age < chrono::Duration::days(7) {
        INTERVAL_COOL
    } else {
        INTERVAL_COLD
    }
}

#[cfg(test)]
mod adaptive_backoff_tests {
    use super::{INTERVAL_COLD, INTERVAL_COOL, INTERVAL_HOT, INTERVAL_WARM, interval_for_age};

    fn ago(minutes: i64) -> chrono::NaiveDateTime {
        chrono::Utc::now().naive_utc() - chrono::Duration::minutes(minutes)
    }

    #[test]
    fn unknown_last_message_is_cold() {
        assert_eq!(interval_for_age(None), INTERVAL_COLD);
    }

    #[test]
    fn fresh_mail_is_hot() {
        assert_eq!(interval_for_age(Some(ago(0))), INTERVAL_HOT);
        assert_eq!(interval_for_age(Some(ago(59))), INTERVAL_HOT);
    }

    #[test]
    fn day_old_mail_is_warm() {
        assert_eq!(interval_for_age(Some(ago(60))), INTERVAL_WARM);
        assert_eq!(interval_for_age(Some(ago(60 * 23))), INTERVAL_WARM);
    }

    #[test]
    fn week_old_mail_is_cool() {
        assert_eq!(interval_for_age(Some(ago(60 * 24))), INTERVAL_COOL);
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 6))), INTERVAL_COOL);
    }

    #[test]
    fn old_mail_is_cold() {
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 7))), INTERVAL_COLD);
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 30))), INTERVAL_COLD);
    }
}

/// Older messages pulled per tick. Capped to keep Gmail rate-limit headroom; at
/// a 30s tick that is ~6000 messages/hour per account.
const BACKFILL_BATCH: usize = 100;

/// Pulls the next batch of older mail, anchoring the window at the oldest email
/// in the local DB. Stops when the provider returns no rows, or when the account
/// has no emails yet and the forward sync is doing the initial pull.
async fn backfill_older(
    pool: &PgPool,
    account_id: i32,
    provider: &crate::email::provider::MailProvider,
    access_token: &str,
) -> Result<()> {
    let oldest: Option<NaiveDateTime> =
        sqlx::query_scalar("SELECT MIN(created_at) FROM emails WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(pool)
            .await?
            .flatten();

    let Some(oldest_naive) = oldest else {
        return Ok(());
    };

    let before_timestamp = oldest_naive.and_utc().timestamp();
    provider
        .sync_before(
            pool,
            account_id,
            access_token,
            before_timestamp,
            BACKFILL_BATCH,
        )
        .await
}

pub async fn fetch_ids(token: &str, last_sync: Option<i64>) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    let mut page_token: Option<String> = None;

    let query = if let Some(ts) = last_sync {
        let safe_ts = ts - 3600;
        format!("&q=after:{}", safe_ts)
    } else {
        "".to_string()
    };

    loop {
        let mut url = format!(
            "{}/gmail/v1/users/me/messages?maxResults=100{}",
            crate::external::gmail_api_base(),
            query
        );

        if let Some(ref t) = page_token {
            url.push_str(&format!("&pageToken={}", t));
        }

        let res: Value = HTTP_CLIENT
            .get(&url)
            .bearer_auth(token)
            .send()
            .await?
            .json()
            .await?;

        if let Some(messages) = res["messages"].as_array() {
            for m in messages {
                if let Some(id) = m["id"].as_str() {
                    ids.push(id.to_string());
                }
            }
        }

        page_token = res["nextPageToken"].as_str().map(|s| s.to_string());

        if page_token.is_none() {
            break;
        }
    }
    Ok(ids)
}

pub async fn fetch_recent_ids(token: &str, max_results: usize) -> Result<Vec<String>> {
    let url = format!(
        "{}/gmail/v1/users/me/messages?maxResults={}",
        crate::external::gmail_api_base(),
        max_results
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

    let ids = res["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(ids)
}

/// Most-recent message ids carrying a given label. `includeSpamTrash=true` is
/// required because Gmail's `messages.list` hides spam and trash even when
/// `labelIds` explicitly asks for them. `fetch_headers_only` then persists the
/// full label array, which is what the sidebar's `= ANY(e.labels)` filter reads.
pub async fn fetch_recent_ids_with_label(
    token: &str,
    label: &str,
    max_results: usize,
) -> Result<Vec<String>> {
    let url = format!(
        "{}/gmail/v1/users/me/messages?maxResults={}&labelIds={}&includeSpamTrash=true",
        crate::external::gmail_api_base(),
        max_results,
        label
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

    let ids = res["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(ids)
}

pub async fn fetch_ids_before(
    token: &str,
    before_timestamp: i64,
    max_results: usize,
) -> Result<Vec<String>> {
    // Without includeSpamTrash the general backfill silently skips spam and
    // trash, leaving the Spam folder stuck at whatever the label pull caught.
    let url = format!(
        "{}/gmail/v1/users/me/messages?maxResults={}&q=before:{}&includeSpamTrash=true",
        crate::external::gmail_api_base(),
        max_results,
        before_timestamp
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

    let ids = res["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(ids)
}

/// `messages.list` filtered by label and a `before:` timestamp. Needed for the
/// per-label backfill because Gmail excludes drafts unless `labelIds=DRAFT` is
/// set explicitly.
pub async fn fetch_label_ids_before(
    token: &str,
    label: &str,
    before_timestamp: i64,
    max_results: usize,
) -> Result<Vec<String>> {
    let url = format!(
        "{}/gmail/v1/users/me/messages?maxResults={}&labelIds={}&q=before:{}&includeSpamTrash=true",
        crate::external::gmail_api_base(),
        max_results,
        label,
        before_timestamp
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

    let ids = res["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(ids)
}

/// Backfills one BACKFILL_BATCH window older than the oldest local message
/// carrying `label`. No-op when the label has no local rows; the recent-only
/// sync bootstraps it in that case.
async fn backfill_label_older(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    label: &str,
) -> Result<()> {
    let oldest: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM emails WHERE account_id = $1 AND $2 = ANY(labels)",
    )
    .bind(account_id)
    .bind(label)
    .fetch_optional(pool)
    .await?
    .flatten();

    let Some(oldest_naive) = oldest else {
        return Ok(());
    };

    let before_timestamp = oldest_naive.and_utc().timestamp();
    let ids = fetch_label_ids_before(token, label, before_timestamp, BACKFILL_BATCH).await?;
    if ids.is_empty() {
        return Ok(());
    }
    debug!(
        target: "worker",
        account_id,
        label,
        count = ids.len(),
        before_timestamp,
        "fetched older label ids"
    );

    let mut tasks = FuturesUnordered::new();
    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });
        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }
    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }
    Ok(())
}

/// Message ids matching a Gmail search `query`, optionally older than
/// `before_timestamp`. Unlike the label walk this is a free-text search, so it
/// can reach mail no local row points at yet. Params go through `.query()` so
/// the `from:`/`before:` operators are URL-encoded correctly.
pub async fn fetch_query_ids(
    token: &str,
    query: &str,
    before_timestamp: Option<i64>,
    max_results: usize,
) -> Result<Vec<String>> {
    let q = match before_timestamp {
        Some(ts) => format!("{query} before:{ts}"),
        None => query.to_string(),
    };
    let url = format!(
        "{}/gmail/v1/users/me/messages",
        crate::external::gmail_api_base()
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .query(&[
            ("maxResults", max_results.to_string()),
            ("q", q),
            ("includeSpamTrash", "true".to_string()),
        ])
        .send()
        .await?
        .json()
        .await?;

    let ids = res["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(ids)
}

/// Backfills one BACKFILL_BATCH window of mail matching a Gmail search.
///
/// The per-label walk seeds off `MIN(created_at)` of rows that already carry the
/// label, so it can never bootstrap a category with no local rows. This variant
/// seeds off `sender_like` instead and, when nothing local matches yet, starts
/// from the newest matching mail — which is how GitHub review mail gets pulled
/// in for the Reviews folder even though no row references it yet.
async fn backfill_query_older(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    query: &str,
    sender_like: &str,
) -> Result<()> {
    let oldest: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM emails \
         WHERE account_id = $1 AND lower(coalesce(sender, '')) LIKE $2",
    )
    .bind(account_id)
    .bind(sender_like)
    .fetch_optional(pool)
    .await?
    .flatten();

    // None => nothing local yet, so pull the newest matching page instead of
    // giving up (the bug that kept Reviews empty).
    let before_timestamp = oldest.map(|dt| dt.and_utc().timestamp());
    let ids = fetch_query_ids(token, query, before_timestamp, BACKFILL_BATCH).await?;
    if ids.is_empty() {
        return Ok(());
    }
    debug!(
        target: "worker",
        account_id,
        query,
        count = ids.len(),
        ?before_timestamp,
        "fetched query-matched ids"
    );

    let mut tasks = FuturesUnordered::new();
    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });
        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }
    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }
    Ok(())
}

pub fn extract_headers(res: &Value) -> (String, String, String) {
    let mut sender: Option<String> = None;
    let mut receiver: Option<String> = None;
    let mut subject: Option<String> = None;

    fn walk_parts(
        node: &Value,
        sender: &mut Option<String>,
        receiver: &mut Option<String>,
        subject: &mut Option<String>,
    ) {
        if let Some(headers) = node["headers"].as_array() {
            for h in headers {
                let name = h["name"].as_str().unwrap_or("");
                let value = h["value"].as_str().unwrap_or("").to_string();

                match name {
                    "From" if sender.is_none() && !value.is_empty() => {
                        *sender = Some(value);
                    }
                    "To" if receiver.is_none() && !value.is_empty() => {
                        *receiver = Some(value);
                    }
                    "Subject" if subject.is_none() && !value.is_empty() => {
                        *subject = Some(value);
                    }
                    _ => {}
                }
            }
        }

        if let Some(parts) = node["parts"].as_array() {
            for part in parts {
                walk_parts(part, sender, receiver, subject);
            }
        }
    }

    walk_parts(&res["payload"], &mut sender, &mut receiver, &mut subject);

    let sender = sender.unwrap_or_else(|| "Unknown".to_string());
    let receiver = receiver.unwrap_or_else(|| "Unknown".to_string());
    let subject = subject.unwrap_or_else(|| "(No Subject)".to_string());

    (sender, receiver, subject)
}

/// Side-pull for messages the INBOX scan misses, such as SPAM and DRAFT. Rows
/// land in `emails` with their full label array so the sidebar filters light up.
/// Best-effort per label: a 4xx on one doesn't break the others or the sync.
async fn sync_account_label_recent(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    label: &str,
    max_results: usize,
) -> anyhow::Result<()> {
    let ids = fetch_recent_ids_with_label(token, label, max_results).await?;
    if ids.is_empty() {
        return Ok(());
    }
    debug!(target: "worker", account_id, label, count = ids.len(), "fetched gmail label ids");

    let mut tasks = FuturesUnordered::new();
    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });
        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }
    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }
    Ok(())
}

// Caps on the side-pulls, which run on every tick so these folders show fresh
// state before backfill walks them. Spam would otherwise fill the table fast.
const GMAIL_SPAM_RECENT_CAP: usize = 50;
const GMAIL_DRAFT_RECENT_CAP: usize = 25;
const GMAIL_TRASH_RECENT_CAP: usize = 50;
const GMAIL_SENT_RECENT_CAP: usize = 50;

#[instrument(target = "worker", skip(pool, token), fields(account_id))]
pub async fn sync_account(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    last_sync: Option<i64>,
) -> anyhow::Result<()> {
    let ids = fetch_ids(token, last_sync).await?;
    debug!(target: "worker", account_id, count = ids.len(), "fetched gmail ids");

    let mut tasks = FuturesUnordered::new();

    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });

        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }

    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }

    let now = chrono::Utc::now().timestamp();

    sqlx::query("UPDATE email_accounts SET last_sync = $1 WHERE id = $2")
        .bind(now)
        .bind(account_id)
        .execute(pool)
        .await?;

    if let Err(err) = refresh_provider_unread_count(pool, account_id, token).await {
        warn!(target: "worker", account_id, error = ?err, "refresh_provider_unread_count failed");
    }

    // Label side-pulls are warned-then-ignored so a 4xx on one label doesn't
    // poison the whole tick.
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "SPAM", GMAIL_SPAM_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "spam sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "DRAFT", GMAIL_DRAFT_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "draft sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "TRASH", GMAIL_TRASH_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "trash sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "SENT", GMAIL_SENT_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "sent sync failed");
    }

    Ok(())
}

#[instrument(target = "worker", skip(pool, token), fields(account_id))]
pub async fn sync_account_recent(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    max_results: usize,
) -> anyhow::Result<()> {
    let ids = fetch_recent_ids(token, max_results).await?;
    debug!(
        target: "worker",
        account_id,
        count = ids.len(),
        "fetched recent gmail ids"
    );

    let mut tasks = FuturesUnordered::new();

    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });

        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }

    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }

    sqlx::query("UPDATE email_accounts SET last_sync = $1 WHERE id = $2")
        .bind(chrono::Utc::now().timestamp())
        .bind(account_id)
        .execute(pool)
        .await?;

    // This is the first-sync path, run right after a Gmail account connects.
    // Stamping the unread count and pulling the label folders here makes the
    // sidebar accurate immediately, rather than only reflecting the recent page
    // until the first full sync.
    if let Err(err) = refresh_provider_unread_count(pool, account_id, token).await {
        warn!(target: "worker", account_id, error = ?err, "refresh_provider_unread_count failed");
    }

    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "SPAM", GMAIL_SPAM_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "spam first-sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "DRAFT", GMAIL_DRAFT_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "draft first-sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "TRASH", GMAIL_TRASH_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "trash first-sync failed");
    }
    if let Err(err) =
        sync_account_label_recent(pool, account_id, token, "SENT", GMAIL_SENT_RECENT_CAP).await
    {
        warn!(target: "worker", account_id, error = ?err, "sent first-sync failed");
    }

    Ok(())
}

#[instrument(target = "worker", skip(pool, token), fields(account_id))]
pub async fn sync_account_before(
    pool: &PgPool,
    account_id: i32,
    token: &str,
    before_timestamp: i64,
    max_results: usize,
) -> anyhow::Result<()> {
    let ids = fetch_ids_before(token, before_timestamp, max_results).await?;
    debug!(
        target: "worker",
        account_id,
        count = ids.len(),
        before_timestamp,
        "fetched older gmail ids"
    );

    let mut tasks = FuturesUnordered::new();

    for id in ids {
        let token = token.to_string();
        tasks.push(async move { fetch_headers_only(&token, &id).await });

        if tasks.len() >= MAX_EMAIL_CONCURRENCY {
            process_batch(pool, account_id, &mut tasks).await?;
        }
    }

    while !tasks.is_empty() {
        process_batch(pool, account_id, &mut tasks).await?;
    }

    Ok(())
}

pub async fn process_batch<F>(
    pool: &PgPool,
    account_id: i32,
    tasks: &mut FuturesUnordered<F>,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = anyhow::Result<EmailHeader>>,
{
    let mut batch: Vec<EmailHeader> = vec![];

    for _ in 0..BATCH_SIZE {
        if let Some(res) = tasks.next().await {
            if let Ok(v) = res {
                batch.push(v);
            }
        } else {
            break;
        }
    }

    if batch.is_empty() {
        return Ok(());
    }

    // `body: None` leaves body_encrypted = '', the pending marker body_worker
    // picks up asynchronously.
    use crate::email::repo::{InsertEmail, upsert_batch};
    let insert_batch: Vec<InsertEmail<'_>> = batch
        .iter()
        .map(
            |(gmail_id, sender, receiver, subject, gmail_timestamp, is_read, labels)| InsertEmail {
                gmail_id,
                sender,
                receiver,
                subject,
                created_at: *gmail_timestamp,
                is_read: *is_read,
                labels: labels.as_slice(),
                body: None,
                attachments_checked: false,
            },
        )
        .collect();
    let returned = upsert_batch(pool, account_id, &insert_batch).await?;

    // The account's owner can't change mid-tick, so resolve it once per batch.
    let owner_row = sqlx::query(
        "SELECT user_id, email, provider, (SELECT organization_id FROM users WHERE id = ea.user_id) AS organization_id
           FROM email_accounts ea WHERE id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = owner_row {
        use crate::webhooks::events::EventOwner;
        use crate::webhooks::{Event, emit};
        let user_id: i32 = row.try_get("user_id").unwrap_or(0);
        let account_email: Option<String> = row.try_get("email").ok();
        let account_provider: Option<String> = row.try_get("provider").ok();
        let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
        let owner = match organization_id {
            Some(org) => EventOwner::user_in_org(user_id, org),
            None => EventOwner::user(user_id),
        };
        for r in &returned {
            if !r.is_new {
                continue;
            }
            // Subject and sender only, never the body: consumers must pull that
            // explicitly from /api/emails/{id} with the email:read scope.
            emit(
                pool,
                owner,
                Event::EmailReceived,
                serde_json::json!({
                    "id": r.id,
                    "account_id": account_id,
                    "sender": r.sender,
                    "subject": r.subject,
                    "received_at": r.created_at,
                }),
            )
            .await;

            // Background sync has no HttpRequest, so the system variant records
            // NULL IP and user agent. from/to/subject land in admin-readable
            // metadata by design.
            crate::audit::record_action_system(
                pool,
                crate::audit::AuditEvent {
                    actor_user_id: user_id,
                    action: "email_received",
                    resource_type: "email",
                    resource_id: Some(r.id.to_string()),
                    metadata: Some(serde_json::json!({
                        "direction": "received",
                        "from": r.sender,
                        "to": account_email,
                        "subject": r.subject,
                        "provider": account_provider,
                        "account_id": account_id,
                        "message_id": r.gmail_id,
                        "received_at": r.created_at,
                    })),
                },
            )
            .await;
        }
    }

    Ok(())
}
