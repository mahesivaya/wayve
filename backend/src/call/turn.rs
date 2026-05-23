//! Cloudflare Realtime TURN credential proxy.
//!
//! The browser can't be trusted with the long-lived Cloudflare API token, so
//! the frontend asks the backend for a short-lived ICE credential each time
//! it builds an `RTCPeerConnection`. The backend forwards the request to
//! Cloudflare's `generate-ice-servers` endpoint and returns the response
//! unchanged.
//!
//! Falls back gracefully: if `CLOUDFLARE_TURN_KEY_ID` /
//! `CLOUDFLARE_TURN_API_TOKEN` aren't set, the endpoint returns 503 and the
//! frontend uses STUN-only servers (calls still work between peers with
//! permissive NATs).

use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use serde_json::Value;
use std::env;
use std::time::Duration;
use tracing::{instrument, warn};

const CLOUDFLARE_TURN_ENDPOINT: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";

// Shared HTTP client with a hard cap on request time so a stalled Cloudflare
// response can't pin an actix worker. Same rationale as
// `billing::provider::HTTP`.
static HTTP: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|err| panic!("failed to build TURN HTTP client: {err}"))
});

fn default_ttl_seconds() -> u64 {
    env::var("CLOUDFLARE_TURN_TTL_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600)
}

#[get("/turn/credentials")]
#[instrument(target = "http", skip(req))]
pub async fn turn_credentials(req: HttpRequest) -> AppResult {
    // Require an authenticated user — credentials are personal-call-tied and
    // must not be mintable by an unauthenticated client.
    let _user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let key_id = env::var("CLOUDFLARE_TURN_KEY_ID").ok().filter(|s| !s.is_empty());
    let token = env::var("CLOUDFLARE_TURN_API_TOKEN").ok().filter(|s| !s.is_empty());

    let (Some(key_id), Some(token)) = (key_id, token) else {
        // Unconfigured: return 503 so the frontend's STUN-only fallback kicks
        // in. This lets dev/test environments run without Cloudflare creds.
        warn!(target: "http", "TURN credentials requested but Cloudflare not configured");
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "error": "turn_not_configured" })));
    };

    let url = format!("{CLOUDFLARE_TURN_ENDPOINT}/{key_id}/credentials/generate-ice-servers");
    let response = HTTP
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "ttl": default_ttl_seconds() }))
        .send()
        .await
        .map_err(|err| {
            warn!(target: "http", error = ?err, "cloudflare TURN request failed");
            AppError::Internal("TURN credential service unavailable".into())
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        warn!(target: "http", %status, body, "cloudflare TURN returned non-success");
        return Err(AppError::Internal(format!(
            "TURN credential service rejected request ({status})"
        )));
    }

    let payload: Value = response.json().await.map_err(|err| {
        warn!(target: "http", error = ?err, "could not parse cloudflare TURN response");
        AppError::Internal("TURN credential response malformed".into())
    })?;

    Ok(HttpResponse::Ok().json(payload))
}
