//! Server-side proxy for `api.github.com`.
//!
//! Why this exists: the frontend GitHub-repo dashboard fires many calls
//! per page load (repo, branches, contents, runs, jobs, workflows,
//! commits). Hitting GitHub directly from the browser as an anonymous
//! caller burns through the 60-req/hr per-IP rate limit in a few
//! refreshes, and any PAT we'd embed in the JS bundle would leak to
//! every visitor's DevTools.
//!
//! What this does: a thin reverse proxy mounted at `/api/github/...`
//! that:
//!   * gates on the caller being logged in (uses the same JWT helper as
//!     every other authenticated endpoint, no separate plumbing),
//!   * forwards to `https://api.github.com/...` with the server-held
//!     `GITHUB_TOKEN` PAT (lifts the limit from 60 to 5000/hr — the
//!     token never crosses the browser boundary),
//!   * caches GET responses in-process for `CACHE_TTL` to absorb the
//!     N-times-per-mount frontend pattern,
//!   * mirrors the upstream status + body so the frontend's existing
//!     error handling (which reads `response.ok` and HTTP status)
//!     works unchanged.
//!
//! `GITHUB_TOKEN` is optional — if unset we still forward but as an
//! anonymous client (matches the original behavior, just centralized).

use crate::cache::TtlCache;
use crate::email::oauth::HTTP_CLIENT;
use actix_web::{HttpRequest, HttpResponse, Responder, get, web};
use once_cell::sync::Lazy;
use std::time::Duration;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

const GITHUB_API: &str = "https://api.github.com";
const CACHE_TTL_SECS: u64 = 60;
const CACHE_MAX: u64 = 1_000;

/// Cached upstream response. Keyed by the URL + query string so two
/// different `?ref=...` calls don't share a bucket.
#[derive(Clone)]
struct CachedResponse {
    status: u16,
    body: Vec<u8>,
}

static GITHUB_CACHE: Lazy<TtlCache<String, CachedResponse>> =
    Lazy::new(|| TtlCache::new(CACHE_MAX, CACHE_TTL_SECS));

fn cache_key(path: &str, query: &str) -> String {
    if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    }
}

fn token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[get("/github/{tail:.*}")]
#[instrument(target = "http", skip(req))]
pub async fn github_proxy(req: HttpRequest, path: web::Path<String>) -> impl Responder {
    // Same gate as every other /api/* endpoint — must be a signed-in
    // user. We don't want any random visitor using us as a free anon-
    // upgrade to GitHub.
    if get_user_id_from_request(&req).is_none() {
        return HttpResponse::Unauthorized().finish();
    }

    let tail = path.into_inner();
    let query = req.query_string();
    let key = cache_key(&tail, query);

    if let Some(cached) = GITHUB_CACHE.get(&key).await {
        return HttpResponse::build(
            actix_web::http::StatusCode::from_u16(cached.status)
                .unwrap_or(actix_web::http::StatusCode::OK),
        )
        .insert_header(("X-Wayve-Cache", "HIT"))
        .insert_header(("Content-Type", "application/json"))
        .body(cached.body);
    }

    let url = if query.is_empty() {
        format!("{GITHUB_API}/{tail}")
    } else {
        format!("{GITHUB_API}/{tail}?{query}")
    };

    // GitHub requires a User-Agent on every request — they 403 calls
    // that omit it. Other headers match what the frontend was sending
    // directly so server semantics (Accept, API version) are preserved.
    let mut builder = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");

    if let Some(pat) = token() {
        builder = builder.header("Authorization", format!("Bearer {pat}"));
    }

    let response = match builder.send().await {
        Ok(resp) => resp,
        Err(e) => {
            warn!(target: "http", error = ?e, url = %url, "github proxy upstream call failed");
            return HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Upstream GitHub call failed"
            }));
        }
    };

    let status = response.status().as_u16();
    let body = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            warn!(target: "http", error = ?e, "github proxy body read failed");
            return HttpResponse::BadGateway().finish();
        }
    };

    // Cache only successful responses — caching a 403/500 would force
    // the user to wait for the TTL even after the rate limit recovers.
    if (200..300).contains(&status) {
        GITHUB_CACHE
            .insert(
                key,
                CachedResponse {
                    status,
                    body: body.clone(),
                },
            )
            .await;
    }

    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status)
            .unwrap_or(actix_web::http::StatusCode::OK),
    )
    .insert_header(("X-Wayve-Cache", "MISS"))
    .insert_header(("Content-Type", "application/json"))
    .body(body)
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_proxy);
}
