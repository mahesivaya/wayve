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
use sqlx::PgPool;
use std::time::Duration;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::resolve_role_context;

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

/// Maps a `?media=...` opt-in to the GitHub `Accept` header that returns
/// the raw representation. Used by the commits-diff fallback in the
/// frontend when GitHub's JSON commit detail omits `files[].patch` for a
/// large text file. Unknown values fall through to JSON.
fn parse_media_override(query: &str) -> Option<&'static str> {
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key != "media" {
            continue;
        }
        return match value {
            "diff" => Some("application/vnd.github.diff"),
            "patch" => Some("application/vnd.github.patch"),
            _ => None,
        };
    }
    None
}

/// Strip `media=...` from the query string before forwarding to GitHub
/// — it's our control knob, not a GitHub-recognized parameter, and we
/// don't want to leak it into upstream URLs (or the upstream cache).
fn strip_media_from_query(query: &str) -> String {
    query
        .split('&')
        .filter(|pair| !(pair.starts_with("media=") || *pair == "media"))
        .collect::<Vec<_>>()
        .join("&")
}

fn token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[get("/github/{tail:.*}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_proxy(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> impl Responder {
    // Authenticated users only. The Code Repo viewer surfaces a single,
    // read-only repository and is offered to every account type: platform
    // staff and org managers/developers via the Workspace section, and
    // personal accounts that opt in via the sidebar "+" add-app button. We
    // still require a valid session so the upstream PAT is never exposed to
    // anonymous callers.
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized().finish();
    };
    if let Err(e) = resolve_role_context(pool.get_ref(), user_id).await {
        warn!(target: "auth", user_id, error = ?e, "github proxy rbac resolution failed");
        return HttpResponse::InternalServerError().finish();
    }

    let tail = path.into_inner();
    let query = req.query_string();
    let media_override = parse_media_override(query);
    // `media=` is our control parameter — never forward it to GitHub.
    let upstream_query = if media_override.is_some() {
        strip_media_from_query(query)
    } else {
        query.to_string()
    };

    // Cache the default JSON branch only. Diff/patch responses are
    // typically much larger than JSON and rarely re-fetched (a user opens
    // a single commit's full diff once); storing them would push hot
    // JSON entries out of the bounded LRU.
    let cache_enabled = media_override.is_none();
    let key = cache_key(&tail, query);

    if cache_enabled && let Some(cached) = GITHUB_CACHE.get(&key).await {
        return HttpResponse::build(
            actix_web::http::StatusCode::from_u16(cached.status)
                .unwrap_or(actix_web::http::StatusCode::OK),
        )
        .insert_header(("X-Wayve-Cache", "HIT"))
        .insert_header(("Content-Type", "application/json"))
        .body(cached.body);
    }

    let url = if upstream_query.is_empty() {
        format!("{GITHUB_API}/{tail}")
    } else {
        format!("{GITHUB_API}/{tail}?{upstream_query}")
    };

    // GitHub requires a User-Agent on every request — they 403 calls
    // that omit it. The Accept header switches to the raw diff/patch
    // representation when the caller opted in via `?media=`.
    let accept_header = media_override.unwrap_or("application/vnd.github+json");
    let mut builder = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", accept_header)
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
    // Capture upstream Content-Type so the diff/patch branch surfaces
    // as `text/plain` (or whatever GitHub returned) rather than being
    // mislabeled JSON. For the JSON branch GitHub returns
    // `application/json; charset=utf-8`, so the existing behavior is
    // preserved — just sourced from upstream instead of hardcoded.
    let upstream_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            warn!(target: "http", error = ?e, "github proxy body read failed");
            return HttpResponse::BadGateway().finish();
        }
    };

    // Cache only successful responses — caching a 403/500 would force
    // the user to wait for the TTL even after the rate limit recovers.
    if cache_enabled && (200..300).contains(&status) {
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

    let response_content_type = upstream_content_type.unwrap_or_else(|| {
        if media_override.is_some() {
            "text/plain; charset=utf-8".to_string()
        } else {
            "application/json".to_string()
        }
    });

    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status).unwrap_or(actix_web::http::StatusCode::OK),
    )
    .insert_header(("X-Wayve-Cache", "MISS"))
    .insert_header(("Content-Type", response_content_type))
    .body(body)
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_proxy);
}
