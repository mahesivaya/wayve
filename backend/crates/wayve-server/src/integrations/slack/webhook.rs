//! Inbound Slack Events API receiver — real-time Slack → Wayve message sync,
//! the counterpart to the on-demand import in `sync::import_all`.
//!
//! Slack signs every request: `X-Slack-Signature: v0=<hmac_hex>` over the base
//! string `v0:{timestamp}:{raw_body}`, keyed by the app **signing secret**
//! (`config::slack_signing_secret`). We verify that — with a 5-minute replay
//! window — before trusting anything. The route is public (no JWT); it's
//! machine-to-machine, like the Jira webhook.
//!
//! A linked Slack channel maps to a Wayve channel via `slack_channel_links`;
//! only enterprise orgs can create links, so matching one is implicitly
//! enterprise-gated. Inbound messages are stored server-readable (enterprise
//! chat is not E2E) and fanned out live to the Wayve channel's members.

use crate::cache::Cache;
use crate::prelude::*;
use actix_web::http::header::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing::{info, instrument, warn};
use wayve_security::encryption::encrypt;

use super::client::SlackClient;
use super::models::{SlackEvent, SlackEventEnvelope};

type HmacSha256 = Hmac<Sha256>;

/// Reject deliveries whose timestamp is more than this far from now (replay
/// protection), per Slack's guidance.
const MAX_TIMESTAMP_SKEW_SECS: i64 = 300;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(slack_events);
}

#[post("/webhooks/slack_events")]
#[instrument(target = "worker", skip(req, pool, cache, body))]
pub async fn slack_events(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
    body: web::Bytes,
) -> AppResult {
    // No signing secret configured → we cannot authenticate Slack → refuse.
    let Some(secret) = crate::config::slack_signing_secret() else {
        warn!(target: "worker", "SLACK_SIGNING_SECRET not set; rejecting Slack event");
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Slack events not configured" })));
    };

    verify_signature(req.headers(), &body, &secret)?;

    let envelope: SlackEventEnvelope = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(e) => {
            warn!(target: "worker", error = %e, "slack event: unparseable payload");
            return Err(AppError::bad_request("invalid Slack event payload"));
        }
    };

    // One-time Events API URL-verification handshake — echo the challenge.
    if envelope.envelope_type == "url_verification" {
        return Ok(HttpResponse::Ok()
            .json(serde_json::json!({ "challenge": envelope.challenge.unwrap_or_default() })));
    }

    // Slack expects a 200 within 3s, so do the work (users.info + DB + fan-out)
    // out of band and ack immediately.
    if envelope.envelope_type == "event_callback"
        && let Some(event) = envelope.event
        && event.event_type == "message"
    {
        let pool = pool.get_ref().clone();
        let cache = cache.get_ref().clone();
        let team_id = envelope.team_id.unwrap_or_default();
        actix_web::rt::spawn(async move {
            if let Err(e) = apply_event(&pool, &cache, &team_id, event).await {
                warn!(target: "worker", error = %e, "slack event apply failed");
            }
        });
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true })))
}

/// Store a Slack message in its linked Wayve channel and fan it out live.
async fn apply_event(
    pool: &PgPool,
    cache: &Option<Cache>,
    team_id: &str,
    event: SlackEvent,
) -> Result<(), AppError> {
    // Skip non-plain messages and anything our own bot posted (echo-loop guard:
    // outbound Wayve→Slack posts come back as `bot_id`/`app_id` messages).
    if event.subtype.is_some() || event.bot_id.is_some() || event.app_id.is_some() {
        return Ok(());
    }
    let Some(slack_channel) = event.channel.as_deref() else {
        return Ok(());
    };

    // Resolve the linked Wayve channel for (Slack channel, workspace). Only
    // enterprise orgs have links, so a match is implicitly enterprise-gated.
    let Some(row) = sqlx::query(
        "SELECT l.wayve_channel_id, l.organization_id, c.connected_by
           FROM slack_channel_links l
           JOIN slack_connections c ON c.organization_id = l.organization_id
          WHERE l.slack_channel_id = $1 AND c.team_id = $2 AND c.enabled",
    )
    .bind(slack_channel)
    .bind(team_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(());
    };
    let wayve_channel_id: i32 = row.get("wayve_channel_id");
    let org_id: i32 = row.get("organization_id");
    let connected_by: Option<i32> = row.try_get("connected_by").unwrap_or(None);

    // Resolve the author display name + any @mentions in the text via the bot
    // token (users.info). Best-effort — falls back to raw ids.
    let (author, text) = match super::handler::load_connection(pool, org_id).await? {
        Some(conn) => {
            let client = SlackClient::new(&conn);
            let author = match &event.user {
                Some(u) => client.user_name(u).await.unwrap_or_else(|| u.clone()),
                None => "slack".to_string(),
            };
            (author, client.resolve_mentions(&event.text).await)
        }
        None => (
            event.user.clone().unwrap_or_else(|| "slack".to_string()),
            event.text.clone(),
        ),
    };
    let body = format!("[Slack · {author}] {text}");

    // Server-readable storage (enterprise chat is not E2E).
    let (iv, enc) = encrypt(&body).map_err(|e| {
        warn!(target: "worker", error = %e, "slack event encrypt failed");
        AppError::Internal("Failed to store Slack message".into())
    })?;

    let inserted = sqlx::query(
        "INSERT INTO channel_messages (channel_id, sender_id, content_encrypted, content_iv)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at",
    )
    .bind(wayve_channel_id)
    .bind(connected_by)
    .bind(enc)
    .bind(iv)
    .fetch_one(pool)
    .await?;
    let message_id: i32 = inserted.get("id");
    let created_naive: chrono::NaiveDateTime = inserted.get("created_at");
    let created_at =
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(created_naive, chrono::Utc);

    info!(target: "worker", org_id, wayve_channel_id, message_id, "slack event stored");

    // Push it to the channel's Wayve members in real time. `content` is the
    // plaintext body (server-readable), which clients render directly.
    let payload = serde_json::json!({
        "message_id": message_id,
        "channel_id": wayve_channel_id,
        "sender_id": connected_by,
        "content": body,
        "status": "sent",
        "created_at": created_at.to_rfc3339(),
        "parent_message_id": serde_json::Value::Null,
    })
    .to_string();

    let members =
        sqlx::query_scalar::<_, i32>("SELECT user_id FROM channel_members WHERE channel_id = $1")
            .bind(wayve_channel_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
    for member_id in members {
        crate::chat::fan_out_user(cache, member_id, payload.clone()).await;
    }
    Ok(())
}

/// Verify Slack's `X-Slack-Signature` over `v0:{timestamp}:{body}` with the
/// signing secret, plus a replay window on the timestamp.
fn verify_signature(headers: &HeaderMap, body: &[u8], secret: &str) -> Result<(), AppError> {
    let timestamp = header_value(headers, "x-slack-request-timestamp")
        .ok_or_else(|| AppError::bad_request("missing Slack timestamp"))?;
    let signature = header_value(headers, "x-slack-signature")
        .ok_or_else(|| AppError::bad_request("missing Slack signature"))?;

    let ts: i64 = timestamp
        .parse()
        .map_err(|_| AppError::bad_request("bad Slack timestamp"))?;
    if (chrono::Utc::now().timestamp() - ts).abs() > MAX_TIMESTAMP_SKEW_SECS {
        return Err(AppError::Unauthorized);
    }

    let body_str = std::str::from_utf8(body).map_err(|_| AppError::bad_request("non-utf8 body"))?;
    let base = format!("v0:{timestamp}:{body_str}");

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Internal("failed to init Slack verifier".into()))?;
    mac.update(base.as_bytes());
    let computed = format!("v0={}", hex_encode(&mac.finalize().into_bytes()));

    if constant_time_eq(computed.as_bytes(), signature.as_bytes()) {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Length-aware constant-time byte comparison (mirrors `jira::webhook`).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches() {
        assert!(constant_time_eq(b"v0=abc", b"v0=abc"));
        assert!(!constant_time_eq(b"v0=abc", b"v0=abd"));
        assert!(!constant_time_eq(b"v0=abc", b"v0=abcd"));
    }

    #[test]
    fn hex_encode_lowercase() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xa9, 0xff]), "000fa9ff");
    }
}
