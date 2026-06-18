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
use wayve_security::rbac::{Role, Scope, resolve_role_context};

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

/// Extract `(owner, repo)` from a proxy tail of the form
/// `repos/{owner}/{repo}[/...]`. Returns `None` for any other shape so the
/// per-caller allowlist only ever applies to the `repos/...` surface the
/// frontend uses (and non-repo tails are rejected for restricted callers).
fn parse_repos_tail(tail: &str) -> Option<(String, String)> {
    let mut segs = tail.split('/');
    if segs.next()? != "repos" {
        return None;
    }
    let owner = segs.next()?;
    let repo = segs.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

#[get("/github/{tail:.*}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_proxy(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> impl Responder {
    // Authenticated callers only — the shared upstream PAT is never exposed to
    // anonymous requests. Beyond that, authorization is per-caller so the proxy
    // can't be used as an open relay against arbitrary (incl. token-readable
    // private) repos:
    //   * Platform staff keep full access (the legacy single-repo dashboard).
    //   * Personal accounts may read ONLY `repos/{owner}/{repo}/...` for a repo
    //     they've linked to one of their own projects (the allowlist).
    //   * Organization members may read ONLY `repos/{owner}/{repo}/...` for a
    //     repo their org owner linked to one of the org's projects.
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized().finish();
    };
    let ctx = match resolve_role_context(pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!(target: "auth", user_id, error = ?e, "github proxy rbac resolution failed");
            return HttpResponse::InternalServerError().finish();
        }
    };

    // Guests never see code, regardless of scope.
    if ctx.role == Role::Guest {
        warn!(target: "auth", user_id, "github proxy denied: guest role");
        return HttpResponse::Forbidden().json(serde_json::json!({
            "message": "You don't have access to this repository"
        }));
    }

    let tail = path.into_inner();

    match ctx.scope {
        Scope::Platform => {}
        Scope::Personal => {
            let Some((owner, repo)) = parse_repos_tail(&tail) else {
                return HttpResponse::Forbidden().finish();
            };
            // Allowlist: the repo must be linked to one of THIS user's projects.
            // GitHub owner/repo are case-insensitive, so compare with LOWER().
            let linked = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM projects
                  WHERE user_id = $1 AND organization_id IS NULL
                    AND LOWER(github_owner) = LOWER($2)
                    AND LOWER(github_repo) = LOWER($3))",
            )
            .bind(user_id)
            .bind(&owner)
            .bind(&repo)
            .fetch_one(pool.get_ref())
            .await;
            if !matches!(linked, Ok(true)) {
                warn!(target: "auth", user_id, owner = %owner, repo = %repo,
                      "github proxy denied: repo not linked to caller");
                return HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this repository"
                }));
            }
        }
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return HttpResponse::Forbidden().finish();
            };
            let Some((owner, repo)) = parse_repos_tail(&tail) else {
                return HttpResponse::Forbidden().finish();
            };
            // Allowlist: ANY member of the org may read a repo linked to one of
            // the org's projects (owner-only linking is enforced at link time).
            let linked = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM projects
                  WHERE organization_id = $1 AND user_id IS NULL
                    AND LOWER(github_owner) = LOWER($2)
                    AND LOWER(github_repo) = LOWER($3))",
            )
            .bind(org_id)
            .bind(&owner)
            .bind(&repo)
            .fetch_one(pool.get_ref())
            .await;
            if !matches!(linked, Ok(true)) {
                warn!(target: "auth", user_id, owner = %owner, repo = %repo,
                      "github proxy denied: repo not linked to caller's org");
                return HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this repository"
                }));
            }
        }
    }
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
