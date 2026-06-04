use crate::prelude::*;

use crate::email::account::load_syncable_email_accounts;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::provider::refresh_and_persist_email_token;

use serde_json::Value;
use tracing::{debug, error, info, instrument, warn};

// (msg_id, sender, receiver, subject, gmail_timestamp, is_read, labels) — body
// is fetched later by body_worker. `labels` carries the message's full Gmail
// `labelIds` (e.g. `["INBOX","IMPORTANT","CATEGORY_UPDATES"]`) so the sidebar
// category folders can filter without an extra round-trip to Gmail.
pub type EmailHeader = (
    String,
    String,
    String,
    String,
    NaiveDateTime,
    bool,
    Vec<String>,
);

/// Fetch the authoritative unread count for the INBOX label and stamp it on
/// `email_accounts.provider_unread_count`. Without this, the sidebar's unread
/// badge only reflects emails Wayve has already synced into Postgres, which
/// grows over time as the user paginates older mail — making the count look
/// like it's "increasing" on every Show More click.
///
/// Best-effort: a failed labels.get is logged and ignored so the rest of the
/// sync still proceeds. The stale count is better than a sync hard-fail.
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
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);
    // Clamp to i32::MAX — unlikely for any real inbox but protects the
    // INTEGER column from a malformed payload.
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

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

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

/// Run the full per-account sync workload: token refresh, forward sync,
/// backfill, label backfill, and post-sync cache invalidation. Errors
/// are logged and swallowed — the worker keeps going for the rest of
/// the accounts in a tick.
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

    // Per-tick backfill of older mail (general window) and the Gmail
    // system/category labels.
    if let Err(err) = backfill_older(
        pool,
        account.id,
        &account.provider,
        &token.access_token,
    )
    .await
    {
        warn!(target: "worker", account_id = account.id, error = ?err, "backfill batch failed");
    }

    for label in [
        "SENT",
        "DRAFT",
        "SPAM",
        "TRASH",
        "CATEGORY_PERSONAL",
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
    ] {
        if let Err(err) = backfill_label_older(
            pool,
            account.id,
            &token.access_token,
            label,
        )
        .await
        {
            warn!(target: "worker", account_id = account.id, label, error = ?err, "label backfill failed");
        }
    }

    // Google Calendar: import upcoming events on the SAME cadence as email
    // (this tick) so the Scheduler stays current, instead of the one-shot
    // import that only ran at connect time. Reuses the token we just
    // refreshed above; best-effort and idempotent (import_upcoming_events
    // upserts ON CONFLICT (user_id, google_event_id)).
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

    // Fresh mail just landed in `emails` — drop the /api/profile and
    // /api/me caches for this user so the Storage & Usage panel
    // reflects the new totals on the next page load instead of waiting
    // out the 30s/60s TTLs.
    crate::routes::user::invalidate_profile_cache(account.user_id).await;
    crate::email::profile::invalidate_me_cache(account.user_id).await;
}

/// Adaptive-backoff scheduler. Called every 30s from the sync worker;
/// only syncs accounts whose per-account next-due time has elapsed, then
/// schedules the next visit based on how recently the mailbox last
/// received mail (the `last_message_at` ladder). `schedule` lives in the
/// worker's process memory and is rebuilt fresh on every restart — a
/// brand-new entry implicitly means "sync now," which is the right
/// startup behavior.
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

    // Drop entries for accounts that no longer appear in the syncable list
    // (account deleted / OAuth revoked). Without this, the schedule map
    // grows unboundedly across re-syncs.
    let live_ids: std::collections::HashSet<i32> =
        due.iter().map(|a| a.id).chain(deferred.iter().map(|a| a.id)).collect();
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
        let Ok((account_id, pre)) = h.await else { continue };
        // Refresh last_message_at to capture any new mail that landed
        // during this tick. One indexed PK lookup per account; cheap.
        let post: Option<NaiveDateTime> = sqlx::query_scalar(
            "SELECT last_message_at FROM email_accounts WHERE id = $1",
        )
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap_or(pre);

        // "New mail landed" = the freshness stamp advanced this tick.
        // Reset to the hot interval so the next pickup is fast; otherwise
        // step up the ladder based on absolute age.
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

// Adaptive-backoff ladder. Quiet accounts back off; busy ones stay hot.
// The brackets balance "user notices new mail quickly" against
// "we don't hammer Gmail/Outlook for inboxes that haven't seen a message
// in a week." Tune via the constants — the rest of the worker is generic.
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
        // Anything < 1h old → 30s.
        assert_eq!(interval_for_age(Some(ago(0))), INTERVAL_HOT);
        assert_eq!(interval_for_age(Some(ago(59))), INTERVAL_HOT);
    }

    #[test]
    fn day_old_mail_is_warm() {
        // 1h–24h → 60s.
        assert_eq!(interval_for_age(Some(ago(60))), INTERVAL_WARM);
        assert_eq!(interval_for_age(Some(ago(60 * 23))), INTERVAL_WARM);
    }

    #[test]
    fn week_old_mail_is_cool() {
        // 24h–7d → 5min.
        assert_eq!(interval_for_age(Some(ago(60 * 24))), INTERVAL_COOL);
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 6))), INTERVAL_COOL);
    }

    #[test]
    fn old_mail_is_cold() {
        // > 7d → 30min.
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 7))), INTERVAL_COLD);
        assert_eq!(interval_for_age(Some(ago(60 * 24 * 30))), INTERVAL_COLD);
    }
}

/// Per-tick backfill window size — how many older messages to pull each
/// time the worker runs. Capped to keep Gmail rate-limit headroom; with a
/// 30s tick this fully backfills ~6000 messages/hour per account, which is
/// enough for almost every personal mailbox to catch up overnight.
const BACKFILL_BATCH: usize = 100;

/// Pulls the next batch of *older* mail for an account. Anchors the window
/// at the oldest email currently in the local DB and asks the provider for
/// the next BACKFILL_BATCH messages older than that. Stops naturally when
/// `sync_before` returns no rows (mailbox exhausted) or when the account has
/// no emails yet (in which case the forward sync handles it).
async fn backfill_older(
    pool: &PgPool,
    account_id: i32,
    provider: &crate::email::provider::MailProvider,
    access_token: &str,
) -> Result<()> {
    let oldest: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT MIN(created_at) FROM emails WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    let Some(oldest_naive) = oldest else {
        // No mail yet — the forward sync (which paginates without a
        // last_sync floor on the first run) is responsible for the
        // initial pull.
        return Ok(());
    };

    let before_timestamp = oldest_naive.and_utc().timestamp();
    provider
        .sync_before(pool, account_id, access_token, before_timestamp, BACKFILL_BATCH)
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

/// Fetch the N most-recent message IDs that carry a specific label
/// (e.g. `SPAM`, `DRAFT`). `includeSpamTrash=true` is required for SPAM
/// because Gmail's default `messages.list` hides spam & trash even when
/// the `labelIds` filter explicitly asks for them. The full `labelIds`
/// array — including the requested label — is extracted by
/// `fetch_headers_only` and persisted into `emails.labels`, so the sidebar
/// filter `'<LABEL>' = ANY(e.labels)` lights up automatically.
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
    // includeSpamTrash=true makes Gmail return SPAM (and TRASH) messages too —
    // without it the general backfill silently skips spam, leaving the
    // Spam folder stuck at whatever the recent label-pull caught.
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

/// `messages.list` variant that filters by label AND a `before:` timestamp.
/// Used by the per-label backfill (DRAFT in particular) since drafts are
/// excluded from `messages.list` unless `labelIds=DRAFT` is set explicitly.
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

/// Backfill older messages within a single Gmail label (e.g. DRAFT, SPAM).
/// Walks one BACKFILL_BATCH window older than the oldest local message
/// currently carrying `label`. No-op when the label has zero local rows —
/// the recent-only sync handles bootstrapping in that case.
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

/// Side-pull for messages that don't live in the INBOX scan: SPAM and DRAFT.
/// Walks the same `fetch_headers_only` → `process_batch` path so the rows
/// land in `emails` with their full `labelIds`, including SPAM/DRAFT, which
/// makes the sidebar filter (`'SPAM' = ANY(e.labels)`) light up. Best-effort
/// per label — a 4xx on one (e.g. the user revoked a scope) doesn't break
/// the others or the main sync.
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

// Cap the side-pulls. Spam fills the table fast and serves zero engagement
// purpose past the "is it there" check; drafts are usually a handful; trash
// is bounded by Gmail's 30-day retention. All are pulled on every sync tick
// so the user sees fresh state for these folders even before backfill walks
// them to completion.
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

    // Best-effort — sidebar unread badge reflects truth even when the user
    // hasn't paginated all the way back through their mailbox.
    if let Err(err) = refresh_provider_unread_count(pool, account_id, token).await {
        warn!(target: "worker", account_id, error = ?err, "refresh_provider_unread_count failed");
    }

    // Pull recent SPAM + DRAFT alongside the INBOX scan so the sidebar's
    // Spam/Drafts folders show real data. Errors are warned-then-ignored
    // so a 4xx on one label doesn't poison the whole tick.
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "SPAM", GMAIL_SPAM_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "spam sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "DRAFT", GMAIL_DRAFT_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "draft sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "TRASH", GMAIL_TRASH_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "trash sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "SENT", GMAIL_SENT_RECENT_CAP).await {
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

    // First-sync hook fires through this path right after a Gmail account
    // connects (see oauth_flow::oauth_callback). Stamping the provider
    // unread count here makes the sidebar badge instantly accurate instead
    // of starting at "however many of the recent 51 are unread" and only
    // catching up after a full sync.
    if let Err(err) = refresh_provider_unread_count(pool, account_id, token).await {
        warn!(target: "worker", account_id, error = ?err, "refresh_provider_unread_count failed");
    }

    // Also pull the first page of SPAM and DRAFT so the sidebar Spam/Drafts
    // folders aren't blank for the first 30s after connect. Same
    // best-effort error handling as sync_account.
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "SPAM", GMAIL_SPAM_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "spam first-sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "DRAFT", GMAIL_DRAFT_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "draft first-sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "TRASH", GMAIL_TRASH_RECENT_CAP).await {
        warn!(target: "worker", account_id, error = ?err, "trash first-sync failed");
    }
    if let Err(err) = sync_account_label_recent(pool, account_id, token, "SENT", GMAIL_SENT_RECENT_CAP).await {
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

    // Headers go through the email repo so the column list, encryption,
    // and is_new detection stay in one place. Body is left empty here —
    // body_worker fills it asynchronously.
    use crate::email::repo::{InsertEmail, upsert_batch};
    let insert_batch: Vec<InsertEmail<'_>> = batch
        .iter()
        .map(|(gmail_id, sender, receiver, subject, gmail_timestamp, is_read, labels)| {
            InsertEmail {
                gmail_id,
                sender,
                receiver,
                subject,
                created_at: *gmail_timestamp,
                is_read: *is_read,
                labels: labels.as_slice(),
                body: None,
                attachments_checked: false,
            }
        })
        .collect();
    let returned = upsert_batch(pool, account_id, &insert_batch).await?;

    // Webhook fan-out. Resolve the owner once per batch (the account's
    // user_id never changes during a sync tick).
    let owner_row = sqlx::query(
        "SELECT user_id, email, (SELECT organization_id FROM users WHERE id = ea.user_id) AS organization_id
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
        let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
        let owner = match organization_id {
            Some(org) => EventOwner::user_in_org(user_id, org),
            None => EventOwner::user(user_id),
        };
        for r in &returned {
            if !r.is_new {
                continue;
            }
            // Subject + sender only — never the body. Body fetches happen
            // asynchronously via body_worker and may carry sensitive content
            // that customers should pull explicitly via /api/emails/{id} if
            // they need it and have the email:read scope.
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

            // Enterprise audit trail (Security → User actions). No HttpRequest
            // here (background sync), so use the system variant — IP/UA are
            // NULL. from/to/subject land in org/platform-admin-readable
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
