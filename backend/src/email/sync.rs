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

#[instrument(target = "worker", skip(pool))]
pub async fn sync_all(pool: &PgPool) -> Result<()> {
    let accounts = load_syncable_email_accounts(pool).await?;

    info!(target: "worker", accounts = accounts.len(), "sync_all start");

    let mut handles = vec![];

    for account in accounts {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            let Some(refresh_token) = account.usable_refresh_token() else {
                warn!(target: "worker", account_id = account.id, "email account skipped: missing refresh token");
                return;
            };

            let token = match refresh_and_persist_email_token(
                &pool,
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
                .sync(&pool, account.id, &token.access_token, account.last_sync)
                .await;

            if let Err(e) = sync_result {
                error!(target: "worker", account_id = account.id, provider = account.provider.as_db(), error = ?e, "email sync failed");
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    Ok(())
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
    let url = format!(
        "{}/gmail/v1/users/me/messages?maxResults={}&q=before:{}",
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
// purpose past the "is it there" check; drafts are usually a handful. Both
// are pulled on every sync tick so the user sees fresh state without
// pagination support for these folders.
const GMAIL_SPAM_RECENT_CAP: usize = 50;
const GMAIL_DRAFT_RECENT_CAP: usize = 25;

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

    // Insert headers with empty body sentinel — body_worker will fill these in.
    let mut query = String::from(
        "INSERT INTO emails(gmail_id, sender, receiver, subject, created_at, body_encrypted, body_iv, account_id, is_read, labels) VALUES ",
    );

    for (i, _) in batch.iter().enumerate() {
        let idx = i * 10;
        query.push_str(&format!(
            "(${}, ${}, ${}, ${}, ${}, ${}, ${}, ${}, ${}, ${}),",
            idx + 1,
            idx + 2,
            idx + 3,
            idx + 4,
            idx + 5,
            idx + 6,
            idx + 7,
            idx + 8,
            idx + 9,
            idx + 10
        ));
    }

    query.pop();
    query.push_str(
        " ON CONFLICT (account_id, gmail_id) DO UPDATE SET \
         sender = EXCLUDED.sender, \
         receiver = EXCLUDED.receiver, \
         subject = EXCLUDED.subject, \
         created_at = EXCLUDED.created_at, \
         is_read = EXCLUDED.is_read, \
         labels = EXCLUDED.labels",
    );

    let mut q = sqlx::query(&query);

    for (gmail_id, sender, receiver, subject, gmail_timestamp, is_read, labels) in batch.iter() {
        q = q
            .bind(gmail_id)
            .bind(sender)
            .bind(receiver)
            .bind(subject)
            .bind(gmail_timestamp)
            .bind("") // body_encrypted — empty until body_worker fills it
            .bind("") // body_iv
            .bind(account_id)
            .bind(is_read)
            .bind(labels);
    }

    q.execute(pool).await?;

    Ok(())
}
