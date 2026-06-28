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
use actix_web::{HttpRequest, HttpResponse, Responder, get, post, put, web};
use once_cell::sync::Lazy;
use sqlx::PgPool;
use std::time::Duration;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Role, Scope, resolve_role_context};

const CACHE_TTL_SECS: u64 = 60;
const CACHE_MAX: u64 = 1_000;

/// Cached upstream response. Keyed by the URL + query string so two
/// different `?ref=...` calls don't share a bucket.
#[derive(Clone)]
struct CachedResponse {
    status: u16,
    body: Vec<u8>,
    /// Upstream `Link` header (GitHub pagination). Forwarded so the frontend can
    /// derive totals (e.g. commit count via `per_page=1` → `rel="last"` page).
    link: Option<String>,
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

/// Whether a proxy tail targets the **pull-request surface** —
/// `repos/{owner}/{repo}/pulls[/...]` (list, detail, files, reviews) plus
/// `repos/{owner}/{repo}/issues/{n}/comments`, which is where GitHub serves a
/// PR's conversation comments (and the only way the dashboard uses `issues`).
/// PRs are owner-only across every scope; this is the predicate for that gate.
fn is_pr_path(tail: &str) -> bool {
    let segs: Vec<&str> = tail.split('/').collect();
    segs.len() >= 4 && segs[0] == "repos" && (segs[3] == "pulls" || segs[3] == "issues")
}

/// Run the full per-caller authorization chain against a `repos/{owner}/{repo}/…`
/// style `tail`, returning `Ok(())` when the caller may touch it or `Err(resp)`
/// carrying the exact 401/403/500 to return verbatim. Shared by the read proxy
/// and the PR-approve write endpoint so both enforce the identical scope,
/// repo-allowlist, and owner-only-PR gates (no drift between read and write).
async fn authorize_github_access(
    req: &HttpRequest,
    pool: &PgPool,
    tail: &str,
) -> std::result::Result<(), HttpResponse> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(HttpResponse::Unauthorized().finish());
    };
    let ctx = match resolve_role_context(pool, user_id).await {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!(target: "auth", user_id, error = ?e, "github proxy rbac resolution failed");
            return Err(HttpResponse::InternalServerError().finish());
        }
    };

    // Guests never see code, regardless of scope.
    if ctx.role == Role::Guest {
        warn!(target: "auth", user_id, "github proxy denied: guest role");
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "You don't have access to this repository"
        })));
    }

    match ctx.scope {
        Scope::Platform => {
            // Feature gate: the platform owner can restrict which platform roles
            // may use the Code Repo viewer (mirrors the org gate below).
            match crate::feature_access::handler::is_allowed_platform(
                pool,
                "code_repo",
                ctx.role.as_str(),
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => {
                    warn!(target: "auth", user_id, role = ctx.role.as_str(),
                          "github proxy denied: code_repo disabled for platform role");
                    return Err(HttpResponse::Forbidden().json(serde_json::json!({
                        "message": "Your role doesn't have access to Code Repo"
                    })));
                }
                Err(e) => {
                    warn!(target: "auth", user_id, error = ?e,
                          "github proxy: platform feature access lookup failed");
                    return Err(HttpResponse::InternalServerError().finish());
                }
            }
        }
        Scope::Personal => {
            let Some((owner, repo)) = parse_repos_tail(tail) else {
                return Err(HttpResponse::Forbidden().finish());
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
            .fetch_one(pool)
            .await;
            if !matches!(linked, Ok(true)) {
                warn!(target: "auth", user_id, owner = %owner, repo = %repo,
                      "github proxy denied: repo not linked to caller");
                return Err(HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this repository"
                })));
            }
        }
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Err(HttpResponse::Forbidden().finish());
            };
            // Feature gate: the org owner can restrict which roles may use the
            // Code Repo viewer at all (separate from the per-repo allowlist).
            match crate::feature_access::handler::is_allowed(
                pool,
                org_id,
                "code_repo",
                ctx.role.as_str(),
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => {
                    warn!(target: "auth", user_id, role = ctx.role.as_str(),
                          "github proxy denied: code_repo disabled for role");
                    return Err(HttpResponse::Forbidden().json(serde_json::json!({
                        "message": "Your role doesn't have access to Code Repo"
                    })));
                }
                Err(e) => {
                    warn!(target: "auth", user_id, error = ?e,
                          "github proxy: feature access lookup failed");
                    return Err(HttpResponse::InternalServerError().finish());
                }
            }
            let Some((owner, repo)) = parse_repos_tail(tail) else {
                return Err(HttpResponse::Forbidden().finish());
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
            .fetch_one(pool)
            .await;
            if !matches!(linked, Ok(true)) {
                warn!(target: "auth", user_id, owner = %owner, repo = %repo,
                      "github proxy denied: repo not linked to caller's org");
                return Err(HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this repository"
                })));
            }
        }
    }

    // Pull requests are visible to the OWNER of each scope only (personal, org,
    // enterprise, and platform owners all resolve to `Role::Owner`). Layered on
    // top of the per-scope repo/feature checks above, so a non-owner who can
    // otherwise read the repo still can't touch its PRs.
    if is_pr_path(tail) && ctx.role != Role::Owner {
        warn!(target: "auth", user_id, role = ctx.role.as_str(),
              "github proxy denied: pull requests are owner-only");
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only the owner can view pull requests"
        })));
    }

    Ok(())
}

#[get("/github/{tail:.*}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_proxy(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> impl Responder {
    // Authenticated, per-caller authorization (scope + repo allowlist +
    // owner-only PR gate). Shared with the approve endpoint so read and write
    // enforce the same rules. Returns the exact response to send on denial.
    let tail = path.into_inner();
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
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
        let mut builder = HttpResponse::build(
            actix_web::http::StatusCode::from_u16(cached.status)
                .unwrap_or(actix_web::http::StatusCode::OK),
        );
        builder
            .insert_header(("X-Wayve-Cache", "HIT"))
            .insert_header(("Content-Type", "application/json"));
        if let Some(link) = &cached.link {
            builder.insert_header(("Link", link.clone()));
        }
        return builder.body(cached.body);
    }

    let api_base = crate::external::github_api_base();
    let url = if upstream_query.is_empty() {
        format!("{api_base}/{tail}")
    } else {
        format!("{api_base}/{tail}?{upstream_query}")
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
    // GitHub's pagination Link header — forwarded so the frontend can read
    // totals (commit count = the `rel="last"` page number when per_page=1).
    let upstream_link = response
        .headers()
        .get(reqwest::header::LINK)
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
                    link: upstream_link.clone(),
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

    let mut builder = HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status).unwrap_or(actix_web::http::StatusCode::OK),
    );
    builder
        .insert_header(("X-Wayve-Cache", "MISS"))
        .insert_header(("Content-Type", response_content_type));
    if let Some(link) = &upstream_link {
        builder.insert_header(("Link", link.clone()));
    }
    builder.body(body)
}

/// Optional approval message. The frontend sends `{}` or `{"body":"…"}`.
#[derive(serde::Deserialize, Default)]
struct ApproveInput {
    #[serde(default)]
    body: Option<String>,
}

/// Build the GitHub review payload from the request body — always an `APPROVE`
/// event, plus an optional non-blank `body` message. Tolerant of an empty or
/// malformed payload (defaults to event-only) so a missing JSON body can't fail
/// the approval.
fn build_approve_review(payload: &[u8]) -> serde_json::Value {
    let mut review = serde_json::json!({ "event": "APPROVE" });
    if let Some(message) = serde_json::from_slice::<ApproveInput>(payload)
        .ok()
        .and_then(|input| input.body)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        review["body"] = serde_json::Value::String(message);
    }
    review
}

/// Optional merge strategy. The frontend sends `{"merge_method":"merge"|"squash"|"rebase"}`.
#[derive(serde::Deserialize, Default)]
struct MergeInput {
    #[serde(default)]
    merge_method: Option<String>,
}

/// Build the GitHub merge payload from the request body. Only `merge`, `squash`,
/// and `rebase` are accepted; anything else (or an empty/malformed payload)
/// falls back to a merge commit — the repo's convention ("Merge pull request #N").
fn build_merge_body(payload: &[u8]) -> serde_json::Value {
    let method = serde_json::from_slice::<MergeInput>(payload)
        .ok()
        .and_then(|input| input.merge_method)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| matches!(s.as_str(), "merge" | "squash" | "rebase"))
        .unwrap_or_else(|| "merge".to_string());
    serde_json::json!({ "merge_method": method })
}

/// Owner-only: submit an `APPROVE` review for a pull request from the in-app
/// code-repo viewer. Reuses the read proxy's authorization chain (so the repo
/// allowlist AND the owner-only PR gate both apply), then POSTs to GitHub's
/// reviews endpoint with the server-held PAT.
///
/// Approving REQUIRES a token with `Pull requests: write`, and GitHub rejects
/// approving your own PR — those upstream errors (403 / 422) are mirrored back
/// verbatim so the UI can surface GitHub's message.
#[post("/github/repos/{owner}/{repo}/pulls/{number}/approve")]
#[instrument(target = "http", skip(req, pool, payload))]
pub async fn approve_pull_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String, i64)>,
    payload: web::Bytes,
) -> impl Responder {
    let (owner, repo, number) = path.into_inner();
    // Reconstruct the canonical PR tail so the shared gate applies the repo
    // allowlist and the owner-only PR check before any write reaches GitHub.
    let tail = format!("repos/{owner}/{repo}/pulls/{number}");
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    // Approving can't be anonymous — without a PAT GitHub would 401 and the
    // action is meaningless. Fail fast with a clear, non-401 message.
    let Some(pat) = token() else {
        warn!(target: "http", "pr approve denied: GITHUB_TOKEN not configured");
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "message": "GitHub isn't connected on the server (no token configured)."
        }));
    };

    let review = build_approve_review(&payload);

    let api_base = crate::external::github_api_base();
    let url = format!("{api_base}/repos/{owner}/{repo}/pulls/{number}/reviews");
    let response = match HTTP_CLIENT
        .post(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .header("Authorization", format!("Bearer {pat}"))
        .json(&review)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            warn!(target: "http", error = ?e, url = %url, "pr approve upstream call failed");
            return HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Upstream GitHub call failed"
            }));
        }
    };

    // Mirror GitHub's status + JSON body so the UI surfaces upstream errors
    // verbatim — e.g. 422 "Can not approve your own pull request." or a 403
    // when the PAT lacks `Pull requests: write`.
    let status = response.status().as_u16();
    let body = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            warn!(target: "http", error = ?e, "pr approve body read failed");
            return HttpResponse::BadGateway().finish();
        }
    };
    if (200..300).contains(&status) {
        info!(target: "http", owner = %owner, repo = %repo, number, "pull request approved");
    } else {
        warn!(target: "http", status, owner = %owner, repo = %repo, number, "pr approve rejected by GitHub");
    }
    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status).unwrap_or(actix_web::http::StatusCode::OK),
    )
    .insert_header(("Content-Type", "application/json"))
    .body(body)
}

/// Owner-only: merge a pull request from the in-app code-repo viewer. Reuses the
/// read proxy's authorization chain (so the repo allowlist AND the owner-only PR
/// gate both apply), then PUTs to GitHub's merge endpoint with the server-held
/// PAT and the chosen `merge_method` (merge / squash / rebase; defaults to a
/// merge commit).
///
/// Merging REQUIRES a token with write access; GitHub's own errors (405 "Pull
/// Request is not mergeable", 409 head-modified, 422) are mirrored back verbatim.
#[put("/github/repos/{owner}/{repo}/pulls/{number}/merge")]
#[instrument(target = "http", skip(req, pool, payload))]
pub async fn merge_pull_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String, i64)>,
    payload: web::Bytes,
) -> impl Responder {
    let (owner, repo, number) = path.into_inner();
    // Reconstruct the canonical PR tail so the shared gate applies the repo
    // allowlist and the owner-only PR check before any write reaches GitHub.
    let tail = format!("repos/{owner}/{repo}/pulls/{number}");
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    // Merging can't be anonymous — without a PAT GitHub would 401. Fail fast.
    let Some(pat) = token() else {
        warn!(target: "http", "pr merge denied: GITHUB_TOKEN not configured");
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "message": "GitHub isn't connected on the server (no token configured)."
        }));
    };

    let merge_body = build_merge_body(&payload);

    let api_base = crate::external::github_api_base();
    let url = format!("{api_base}/repos/{owner}/{repo}/pulls/{number}/merge");
    let response = match HTTP_CLIENT
        .put(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .header("Authorization", format!("Bearer {pat}"))
        .json(&merge_body)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            warn!(target: "http", error = ?e, url = %url, "pr merge upstream call failed");
            return HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Upstream GitHub call failed"
            }));
        }
    };

    // Mirror GitHub's status + JSON body so the UI surfaces upstream errors
    // verbatim — e.g. 405 "Pull Request is not mergeable" or 409 head-modified.
    let status = response.status().as_u16();
    let body = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            warn!(target: "http", error = ?e, "pr merge body read failed");
            return HttpResponse::BadGateway().finish();
        }
    };
    if (200..300).contains(&status) {
        info!(target: "http", owner = %owner, repo = %repo, number, "pull request merged");
    } else {
        warn!(target: "http", status, owner = %owner, repo = %repo, number, "pr merge rejected by GitHub");
    }
    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status).unwrap_or(actix_web::http::StatusCode::OK),
    )
    .insert_header(("Content-Type", "application/json"))
    .body(body)
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_proxy);
    cfg.service(approve_pull_request);
    cfg.service(merge_pull_request);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_review_without_message_is_event_only() {
        let review = build_approve_review(b"{}");
        assert_eq!(review["event"], "APPROVE");
        assert!(review.get("body").is_none());
    }

    #[test]
    fn approve_review_includes_trimmed_message() {
        let review = build_approve_review(br#"{"body":"  LGTM  "}"#);
        assert_eq!(review["event"], "APPROVE");
        assert_eq!(review["body"], "LGTM");
    }

    #[test]
    fn approve_review_ignores_blank_or_malformed_body() {
        // Blank message → omitted; malformed JSON → still a valid approve.
        assert!(
            build_approve_review(br#"{"body":"   "}"#)
                .get("body")
                .is_none()
        );
        let from_garbage = build_approve_review(b"not json at all");
        assert_eq!(from_garbage["event"], "APPROVE");
        assert!(from_garbage.get("body").is_none());
    }

    #[test]
    fn approve_tail_is_owner_gated_pr_path() {
        // The reconstructed approve tail must trip the owner-only PR gate.
        assert!(is_pr_path("repos/acme/widgets/pulls/42"));
        assert_eq!(
            parse_repos_tail("repos/acme/widgets/pulls/42"),
            Some(("acme".to_string(), "widgets".to_string()))
        );
    }

    #[test]
    fn merge_body_defaults_to_merge_commit() {
        assert_eq!(build_merge_body(b"{}")["merge_method"], "merge");
        assert_eq!(build_merge_body(b"not json")["merge_method"], "merge");
    }

    #[test]
    fn merge_body_accepts_valid_methods() {
        assert_eq!(
            build_merge_body(br#"{"merge_method":"squash"}"#)["merge_method"],
            "squash"
        );
        // Case-insensitive normalisation.
        assert_eq!(
            build_merge_body(br#"{"merge_method":"REBASE"}"#)["merge_method"],
            "rebase"
        );
    }

    #[test]
    fn merge_body_rejects_unknown_method() {
        // An unknown/garbage method falls back to a merge commit, never forwarded.
        assert_eq!(
            build_merge_body(br#"{"merge_method":"yolo"}"#)["merge_method"],
            "merge"
        );
    }
}
