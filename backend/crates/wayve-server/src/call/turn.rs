//! Cloudflare Realtime TURN credential proxy.
//!
//! The long-lived Cloudflare API token must not reach the browser, so the
//! frontend asks the backend for a short-lived ICE credential whenever it builds
//! an `RTCPeerConnection` and the backend proxies Cloudflare's
//! `generate-ice-servers` response unchanged.
//!
//! Without `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` the endpoint
//! returns 503 and the frontend falls back to STUN-only servers, which still
//! connect peers behind permissive NATs.

use crate::prelude::*;
use serde_json::Value;
use std::env;
use std::time::Duration;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

const CLOUDFLARE_TURN_ENDPOINT: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";

// The request timeout is a hard cap so a stalled Cloudflare response cannot pin
// an actix worker.
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

#[instrument(target = "http", skip(req))]
pub async fn turn_credentials(req: HttpRequest) -> AppResult {
    // Credentials must not be mintable by an unauthenticated client.
    let _user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let key_id = env::var("CLOUDFLARE_TURN_KEY_ID")
        .ok()
        .filter(|s| !s.is_empty());
    let token = env::var("CLOUDFLARE_TURN_API_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());

    let (Some(key_id), Some(token)) = (key_id, token) else {
        // 503 triggers the frontend's STUN-only fallback, so dev and test
        // environments run without Cloudflare credentials.
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
