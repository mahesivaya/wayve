//! Fills in the Cc header of Gmail mail synced before Cc was stored, so Reply
//! all can include everyone on those messages too.
//!
//! New mail gets its Cc at sync time. Older rows have `cc_encrypted IS NULL`
//! (unknown), and each sync tick re-reads a small batch of them from Gmail,
//! newest first. The batch is kept small and stops at the first refusal, so it
//! never competes with the sync for the mailbox's per-user Gmail quota.

use crate::email::oauth::HTTP_CLIENT;
use crate::email::provider::MailProvider;
use crate::prelude::*;
use futures::stream::{self, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::warn;

/// Messages filled in per account per sync tick.
const BATCH: i64 = 25;
/// Concurrent Gmail requests within one batch.
const CONCURRENCY: usize = 4;

/// The outcome of re-reading one message's Cc.
enum Fetched {
    Cc(String),
    /// Gmail has no such message (deleted since, or an id it rejects as
    /// invalid); recorded as no Cc so it isn't retried every tick.
    Gone,
}

/// Fills in the Cc of up to `BATCH` of this account's Gmail messages whose Cc
/// isn't known yet. Returns how many were filled in. Gmail only: Outlook and
/// IMAP mail is stored with its Cc as it syncs.
pub async fn backfill_batch(
    pool: &PgPool,
    account_id: i32,
    provider: &MailProvider,
    access_token: &str,
) -> anyhow::Result<usize> {
    if !matches!(provider, MailProvider::Google) {
        return Ok(0);
    }
    let pending: Vec<String> = sqlx::query_scalar(
        "SELECT gmail_id FROM emails \
         WHERE account_id = $1 AND cc_encrypted IS NULL AND gmail_id IS NOT NULL \
         ORDER BY created_at DESC NULLS LAST LIMIT $2",
    )
    .bind(account_id)
    .bind(BATCH)
    .fetch_all(pool)
    .await?;

    // After the first refusal (rate limit, expired access) no new request is
    // started; answers already on their way are still stored, and whatever is
    // left stays unknown for a later tick.
    let refused = AtomicBool::new(false);
    let mut fetches = stream::iter(pending)
        .map(|gmail_id| {
            let refused = &refused;
            async move {
                if refused.load(Ordering::Relaxed) {
                    return (gmail_id, None);
                }
                let fetched = fetch_cc(access_token, &gmail_id).await;
                if fetched.is_err() {
                    refused.store(true, Ordering::Relaxed);
                }
                (gmail_id, Some(fetched))
            }
        })
        .buffer_unordered(CONCURRENCY);
    let mut filled = 0;
    let mut first_refusal: Option<anyhow::Error> = None;
    while let Some((gmail_id, fetched)) = fetches.next().await {
        let cc = match fetched {
            Some(Ok(Fetched::Cc(cc))) => cc,
            Some(Ok(Fetched::Gone)) => String::new(),
            Some(Err(e)) => {
                first_refusal.get_or_insert(e);
                continue;
            }
            None => continue,
        };
        crate::email::repo::set_cc(pool, account_id, &gmail_id, &cc).await?;
        filled += 1;
    }
    if let Some(e) = first_refusal {
        warn!(target: "worker", account_id, filled, error = ?e, "cc backfill paused");
    }
    Ok(filled)
}

async fn fetch_cc(token: &str, gmail_id: &str) -> anyhow::Result<Fetched> {
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=Cc",
        crate::external::gmail_api_base(),
        gmail_id
    );
    let resp = HTTP_CLIENT.get(&url).bearer_auth(token).send().await?;
    // Deleted in Gmail since.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Fetched::Gone);
    }
    // An id Gmail rejects outright ("Invalid id value"), such as a seeded or
    // synthetic row: asking again never helps, and left unknown it would be
    // retried, newest first, on every tick. Only that reason: Gmail answers 400
    // for mailbox-wide problems too (Gmail turned off for a Workspace user), and
    // recording those as "no Cc" would lose every Cc in the mailbox for good.
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        let error: Value = resp.json().await.unwrap_or_default();
        if is_invalid_id(&error) {
            return Ok(Fetched::Gone);
        }
        anyhow::bail!(
            "gmail cc fetch for {gmail_id} failed: HTTP 400 {}",
            error["error"]["status"].as_str().unwrap_or("")
        );
    }
    // A refusal (rate limit, expired access) must never be recorded as "no Cc".
    if !resp.status().is_success() {
        anyhow::bail!(
            "gmail cc fetch for {gmail_id} failed: HTTP {}",
            resp.status()
        );
    }
    let res: Value = resp.json().await?;
    if !res["payload"].is_object() {
        anyhow::bail!("gmail cc fetch for {gmail_id} returned no message");
    }
    Ok(Fetched::Cc(crate::email::sync::extract_cc(&res)))
}

/// Whether a Gmail 400 body says the message id itself is invalid
/// (`"status": "INVALID_ARGUMENT"`, reason `invalidArgument`), as opposed to a
/// problem with the mailbox.
fn is_invalid_id(error: &Value) -> bool {
    error["error"]["status"].as_str() == Some("INVALID_ARGUMENT")
        || error["error"]["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|e| e["reason"].as_str() == Some("invalidArgument"))
}
