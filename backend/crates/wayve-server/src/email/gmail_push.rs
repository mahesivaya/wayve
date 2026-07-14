//! Gmail instant new-mail via `users.watch` → standard Cloud Pub/Sub.
//!
//! `start_watch` arms a watch so new INBOX mail publishes to our Pub/Sub topic;
//! `gmail_push_endpoint` receives the push and runs the same `after:last_sync`
//! forward sync the 30s poll uses, then nudges the owner's browser over the chat
//! WebSocket. The poll remains the fallback for missed pushes and lapsed
//! watches. `gmail_history_id` is recorded from the watch response but unused;
//! it is reserved for a future `history.list` path.

use crate::cache::Cache;
use crate::email::account;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::provider::refresh_and_persist_email_token;
use crate::prelude::*;
use base64::Engine as _;
use tracing::{info, instrument, warn};

/// Arm a Gmail watch for `account_id` so new INBOX mail publishes to our topic.
/// No-op (Ok) when `GMAIL_PUSH_TOPIC` is unset — push is optional; the poll
/// still covers the account.
#[instrument(target = "worker", skip(pool, access_token))]
pub async fn start_watch(pool: &PgPool, account_id: i32, access_token: &str) -> Result<()> {
    let Some(topic) = crate::config::gmail_push_topic() else {
        return Ok(());
    };
    let url = format!(
        "{}/gmail/v1/users/me/watch",
        crate::external::gmail_api_base()
    );
    let res = HTTP_CLIENT
        .post(&url)
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "topicName": topic,
            "labelIds": ["INBOX"],
            "labelFilterBehavior": "INCLUDE",
        }))
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        warn!(target: "worker", account_id, %status, body = %body, "gmail watch failed");
        anyhow::bail!("gmail watch failed: {status}");
    }
    let v: serde_json::Value = res.json().await?;
    // `historyId` is a stringified u64; `expiration` is epoch-millis as a string.
    let history_id = v["historyId"].as_str().and_then(|s| s.parse::<i64>().ok());
    let watch_expires_at = v["expiration"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.naive_utc());
    sqlx::query(
        "UPDATE email_accounts \
            SET gmail_history_id = COALESCE($1, gmail_history_id), watch_expires_at = $2 \
          WHERE id = $3",
    )
    .bind(history_id)
    .bind(watch_expires_at)
    .bind(account_id)
    .execute(pool)
    .await?;
    info!(target: "worker", account_id, "gmail watch armed");
    Ok(())
}

/// Push-triggered delta sync for one mailbox: refresh the token, run the
/// existing forward sync (stores new mail), then nudge the owner's browser.
#[instrument(target = "worker", skip(pool, cache))]
pub async fn sync_on_push(pool: &PgPool, cache: &Option<Cache>, email: &str) -> Result<()> {
    let Some(acct) = account::load_email_account_by_email(pool, email).await? else {
        warn!(target: "worker", email, "gmail push for unknown mailbox; ignoring");
        return Ok(());
    };
    let Some(refresh_token) = acct.usable_refresh_token() else {
        warn!(target: "worker", account_id = acct.id, "gmail push: no refresh token");
        return Ok(());
    };
    let token =
        refresh_and_persist_email_token(pool, acct.id, acct.provider, refresh_token).await?;
    acct.provider
        .sync(pool, acct.id, &token.access_token, acct.last_sync)
        .await?;
    // Best-effort nudge; the email page's WS listener keys on this `type`.
    let payload = serde_json::json!({ "type": "email:new", "account_id": acct.id }).to_string();
    crate::chat::fan_out_user(cache, acct.user_id, payload).await;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct PushQuery {
    pub token: Option<String>,
}

#[derive(serde::Deserialize)]
struct PushEnvelope {
    message: PushMessage,
}

#[derive(serde::Deserialize)]
struct PushMessage {
    /// Base64 (standard) of the Gmail notification JSON.
    data: String,
}

#[derive(serde::Deserialize)]
struct GmailNotification {
    #[serde(rename = "emailAddress")]
    email_address: String,
}

/// PUBLIC route (no JWT). Pub/Sub authenticates via a shared `?token=` secret
/// matched against `GMAIL_PUSH_SECRET` (when set). ACKs immediately and
/// processes async — Pub/Sub retries on non-2xx, so we never block on the sync.
#[instrument(target = "worker", skip(pool, cache, query, body))]
pub async fn gmail_push_endpoint(
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
    query: web::Query<PushQuery>,
    body: web::Bytes,
) -> impl Responder {
    if let Some(secret) = crate::config::gmail_push_secret()
        && query.token.as_deref() != Some(secret.as_str())
    {
        warn!(target: "worker", "gmail push rejected: bad/missing token");
        return HttpResponse::Unauthorized().finish();
    }

    let envelope: PushEnvelope = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&envelope.message.data) {
        Ok(d) => d,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };
    let notif: GmailNotification = match serde_json::from_slice(&decoded) {
        Ok(n) => n,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };

    let pool = pool.get_ref().clone();
    let cache = cache.get_ref().clone();
    tokio::spawn(async move {
        if let Err(e) = sync_on_push(&pool, &cache, &notif.email_address).await {
            warn!(target: "worker", error = ?e, "gmail push sync failed");
        }
    });
    HttpResponse::Ok().finish()
}
