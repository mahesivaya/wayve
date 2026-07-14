//! Authenticated reverse proxy for `api.github.com`, mounted at `/api/github/`.
//!
//! Calling GitHub straight from the browser burns the anonymous 60-req/hr per-IP
//! limit in a few refreshes, and a PAT in the JS bundle would leak to every
//! visitor. So the proxy forwards with the server-held `GITHUB_TOKEN`, caches GETs
//! in-process for `CACHE_TTL_SECS`, and mirrors the upstream status and body
//! verbatim. `GITHUB_TOKEN` is optional; without it requests go anonymously.

use crate::cache::TtlCache;
use crate::email::oauth::HTTP_CLIENT;
use actix_web::{HttpRequest, HttpResponse, Responder, get, post, put, web};
use once_cell::sync::Lazy;
use sqlx::PgPool;
use std::time::Duration;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Role, Scope, resolve_role_context_moded};

const CACHE_TTL_SECS: u64 = 60;
const CACHE_MAX: u64 = 1_000;

/// Cached upstream response, keyed by URL plus query string so two different
/// `?ref=...` calls don't share a bucket.
#[derive(Clone)]
struct CachedResponse {
    status: u16,
    body: Vec<u8>,
    /// Upstream `Link` header. Forwarded so the frontend can derive totals, e.g.
    /// commit count from the `rel="last"` page number with `per_page=1`.
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

/// Map a `?media=...` opt-in to the GitHub `Accept` header for the raw
/// representation, used by the frontend's commits-diff fallback when GitHub's
/// JSON commit detail omits `files[].patch`. Unknown values fall through to JSON.
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

/// Strip `media=...` from the query string before forwarding. It is our control
/// knob, not a GitHub parameter, and must not leak into upstream URLs.
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

/// The GitHub token to act as for a request. Personal-scope callers who connected
/// their own GitHub act as themselves; everyone else uses the shared server PAT.
/// The single branch point for the per-user feature.
pub(crate) async fn effective_github_token(req: &HttpRequest, pool: &PgPool) -> Option<String> {
    if let Some(user_id) = get_user_id_from_request(req)
        && let Ok(ctx) = resolve_role_context_moded(req, pool, user_id).await
        && ctx.scope == Scope::Personal
        && let Some(user_token) = crate::github_oauth::stored_token_for(pool, user_id).await
    {
        return Some(user_token);
    }
    token()
}

/// Fetch the repo objects `bearer` can see. `Err(())` on a transport or upstream
/// failure so the caller can 502.
pub async fn list_repos(bearer: Option<&str>) -> Result<Vec<serde_json::Value>, ()> {
    let api_base = crate::external::github_api_base();
    let url = format!(
        "{api_base}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
    );
    let mut builder = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");
    if let Some(pat) = bearer {
        builder = builder.header("Authorization", format!("Bearer {pat}"));
    }
    let response = builder.send().await.map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    response
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|_| ())
}

/// Extract `(owner, repo)` from a `repos/{owner}/{repo}[/...]` proxy tail. `None`
/// for any other shape, so the per-caller allowlist only applies to the
/// `repos/...` surface and other tails are rejected for restricted callers.
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

/// Whether a proxy tail targets the pull-request surface: `.../pulls[/...]` plus
/// `.../issues/{n}/comments`, where GitHub serves a PR's conversation comments.
/// PRs are owner-only in every scope, and this is the predicate for that gate.
fn is_pr_path(tail: &str) -> bool {
    let segs: Vec<&str> = tail.split('/').collect();
    segs.len() >= 4 && segs[0] == "repos" && (segs[3] == "pulls" || segs[3] == "issues")
}

/// Roles that see every project in their scope; every other role reaches only the
/// repos granted to it in `member_project_access`. Must stay in sync with the arm
/// in `visible_projects` so the list and the 403 gate agree.
fn is_project_admin(role: Role) -> bool {
    matches!(role, Role::Owner | Role::SuperAdmin | Role::Admin)
}

/// Whether `user_id` has been granted `owner/repo` in `member_project_access`.
/// Case-insensitive, as GitHub owner/repo names are, matching the link allowlists.
async fn member_has_repo_grant(pool: &PgPool, user_id: i32, owner: &str, repo: &str) -> bool {
    let full_name = format!("{owner}/{repo}");
    matches!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM member_project_access \
             WHERE user_id = $1 AND LOWER(repo_full_name) = LOWER($2))",
        )
        .bind(user_id)
        .bind(&full_name)
        .fetch_one(pool)
        .await,
        Ok(true)
    )
}

/// Run the per-caller authorization chain against a proxy `tail`, returning
/// `Err(resp)` with the exact 401/403/500 to send on denial. Shared by the read
/// proxy and the PR write endpoints so the scope, repo-allowlist, and
/// owner-only-PR gates can't drift between read and write.
async fn authorize_github_access(
    req: &HttpRequest,
    pool: &PgPool,
    tail: &str,
) -> std::result::Result<(), HttpResponse> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(HttpResponse::Unauthorized().finish());
    };
    let ctx = match resolve_role_context_moded(req, pool, user_id).await {
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
            // The platform owner can disable the Code Repo viewer per role.
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
            // Restricted roles reach only granted repos. Repo tails only, so
            // `/user/repos` and other lists are unaffected.
            if !is_project_admin(ctx.role)
                && let Some((owner, repo)) = parse_repos_tail(tail)
                && !member_has_repo_grant(pool, user_id, &owner, &repo).await
            {
                warn!(target: "auth", user_id, role = ctx.role.as_str(), owner = %owner, repo = %repo,
                      "github proxy denied: repo not granted to platform member");
                return Err(HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this project"
                })));
            }
        }
        Scope::Personal => {
            let Some((owner, repo)) = parse_repos_tail(tail) else {
                return Err(HttpResponse::Forbidden().finish());
            };
            // The repo must be linked to one of this user's own projects. GitHub
            // owner/repo names are case-insensitive, hence LOWER().
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
            // The org owner can disable the Code Repo viewer per role, separately
            // from the per-repo allowlist below.
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
            // Any member may read a repo linked to an org project; owner-only
            // linking is enforced at link time.
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
            // Restricted org roles only reach granted repos.
            if !is_project_admin(ctx.role)
                && !member_has_repo_grant(pool, user_id, &owner, &repo).await
            {
                warn!(target: "auth", user_id, role = ctx.role.as_str(), owner = %owner, repo = %repo,
                      "github proxy denied: repo not granted to org member");
                return Err(HttpResponse::Forbidden().json(serde_json::json!({
                    "message": "You don't have access to this project"
                })));
            }
        }
    }

    // Pull requests are owner-only in every scope, layered on top of the per-scope
    // checks above: a non-owner who can read the repo still can't touch its PRs.
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
    let tail = path.into_inner();
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    let query = req.query_string();
    let media_override = parse_media_override(query);
    let upstream_query = if media_override.is_some() {
        strip_media_from_query(query)
    } else {
        query.to_string()
    };

    // JSON only: diff/patch responses are large and rarely re-fetched, so caching
    // them would evict hot JSON from the bounded LRU.
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

    // GitHub 403s any request without a User-Agent.
    let accept_header = media_override.unwrap_or("application/vnd.github+json");
    let mut builder = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", accept_header)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");

    if let Some(pat) = effective_github_token(&req, pool.get_ref()).await {
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
    // Echo the upstream Content-Type so diff/patch isn't mislabeled as JSON.
    let upstream_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
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

    // Success only: caching a 403/500 would make the user wait out the TTL even
    // after the rate limit recovers.
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

/// Build the GitHub review payload. An empty or malformed payload degrades to
/// event-only so a missing JSON body can't fail the approval.
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

/// Build the GitHub merge payload. Only `merge`, `squash`, and `rebase` are
/// accepted; anything else, including an empty or malformed payload, falls back
/// to a merge commit.
fn build_merge_body(payload: &[u8]) -> serde_json::Value {
    let method = serde_json::from_slice::<MergeInput>(payload)
        .ok()
        .and_then(|input| input.merge_method)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| matches!(s.as_str(), "merge" | "squash" | "rebase"))
        .unwrap_or_else(|| "merge".to_string());
    serde_json::json!({ "merge_method": method })
}

/// Owner-only: submit an `APPROVE` review for a pull request. Requires a token
/// with `Pull requests: write`, and GitHub rejects approving your own PR; those
/// upstream 403/422 errors are mirrored back verbatim.
#[post("/github/repos/{owner}/{repo}/pulls/{number}/approve")]
#[instrument(target = "http", skip(req, pool, payload))]
pub async fn approve_pull_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String, i64)>,
    payload: web::Bytes,
) -> impl Responder {
    let (owner, repo, number) = path.into_inner();
    // Canonical PR tail, so the shared gate runs before any write reaches GitHub.
    let tail = format!("repos/{owner}/{repo}/pulls/{number}");
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    // Fail fast rather than let GitHub 401 an anonymous approve.
    let Some(pat) = effective_github_token(&req, pool.get_ref()).await else {
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

/// Owner-only: merge a pull request with the chosen `merge_method`. Requires a
/// token with write access; GitHub's errors (405 not mergeable, 409 head-modified,
/// 422) are mirrored back verbatim.
#[put("/github/repos/{owner}/{repo}/pulls/{number}/merge")]
#[instrument(target = "http", skip(req, pool, payload))]
pub async fn merge_pull_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String, i64)>,
    payload: web::Bytes,
) -> impl Responder {
    let (owner, repo, number) = path.into_inner();
    // Canonical PR tail, so the shared gate runs before any write reaches GitHub.
    let tail = format!("repos/{owner}/{repo}/pulls/{number}");
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    // Fail fast rather than let GitHub 401 an anonymous merge.
    let Some(pat) = effective_github_token(&req, pool.get_ref()).await else {
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

/// The comment body posted from the in-app commit view (`{"body": "..."}`).
#[derive(serde::Deserialize, Default)]
struct CommitCommentInput {
    #[serde(default)]
    body: Option<String>,
}

/// Post a conversation comment on a commit. The comment is attributed to the
/// shared token's GitHub account, not the individual app user; per-user
/// attribution would need per-user OAuth.
#[post("/github/repos/{owner}/{repo}/commits/{sha}/comments")]
#[instrument(target = "http", skip(req, pool, payload))]
pub async fn create_commit_comment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String, String)>,
    payload: web::Bytes,
) -> impl Responder {
    let (owner, repo, sha) = path.into_inner();
    // Same gate as reading the repo: anyone with Code Repo access may comment.
    let tail = format!("repos/{owner}/{repo}/commits/{sha}");
    if let Err(resp) = authorize_github_access(&req, pool.get_ref(), &tail).await {
        return resp;
    }

    let Some(pat) = effective_github_token(&req, pool.get_ref()).await else {
        warn!(target: "http", "commit comment denied: GITHUB_TOKEN not configured");
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "message": "GitHub isn't connected on the server (no token configured)."
        }));
    };

    let body_text = serde_json::from_slice::<CommitCommentInput>(&payload)
        .ok()
        .and_then(|input| input.body)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(body_text) = body_text else {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Comment body is required"
        }));
    };

    let api_base = crate::external::github_api_base();
    let url = format!("{api_base}/repos/{owner}/{repo}/commits/{sha}/comments");
    let response = match HTTP_CLIENT
        .post(&url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .header("Authorization", format!("Bearer {pat}"))
        .json(&serde_json::json!({ "body": body_text }))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            warn!(target: "http", error = ?e, url = %url, "commit comment upstream call failed");
            return HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Upstream GitHub call failed"
            }));
        }
    };

    let status = response.status().as_u16();
    let resp_body = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            warn!(target: "http", error = ?e, "commit comment body read failed");
            return HttpResponse::BadGateway().finish();
        }
    };
    if (200..300).contains(&status) {
        info!(target: "http", owner = %owner, repo = %repo, sha = %sha, "commit comment posted");
    } else {
        warn!(target: "http", status, owner = %owner, repo = %repo, "commit comment rejected by GitHub");
    }
    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status).unwrap_or(actix_web::http::StatusCode::OK),
    )
    .insert_header(("Content-Type", "application/json"))
    .body(resp_body)
}

/// The Projects page data for the current user. Project admins are unrestricted;
/// other members see only the repos granted to them in `member_project_access`.
/// Filtered server-side so a restricted member can't bypass a client filter.
#[get("/projects/visible")]
#[instrument(target = "http", skip(req, pool))]
pub async fn visible_projects(req: HttpRequest, pool: web::Data<PgPool>) -> HttpResponse {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };

    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id)
        .await
        .ok();

    // A personal account with no GitHub connection must NOT fall through to the
    // shared server PAT below, which would list the server account's repos to a
    // user who imported nothing.
    if matches!(ctx.as_ref(), Some(c) if c.scope == Scope::Personal)
        && crate::github_oauth::stored_token_for(pool.get_ref(), user_id)
            .await
            .is_none()
    {
        return HttpResponse::Ok().json(serde_json::json!({
            "unrestricted": true,
            "connected": false,
            "repos": [],
        }));
    }

    let unrestricted = match ctx.as_ref() {
        Some(c) => match c.scope {
            Scope::Platform | Scope::Organization => is_project_admin(c.role),
            // Connected personal accounts are not managed by this feature.
            Scope::Personal => true,
        },
        // Fail open to "see all" rather than hiding everything on a lookup error.
        None => true,
    };

    let bearer = effective_github_token(&req, pool.get_ref()).await;
    let repos = match list_repos(bearer.as_deref()).await {
        Ok(repos) => repos,
        Err(()) => {
            return HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not load repositories from GitHub" }));
        }
    };

    let repos = if unrestricted {
        repos
    } else {
        let allowed: std::collections::HashSet<String> = match sqlx::query_scalar::<_, String>(
            "SELECT repo_full_name FROM member_project_access WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_all(pool.get_ref())
        .await
        {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                warn!(target: "http", error = ?e, "visible_projects: grant lookup failed");
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "message": "Could not load project access" }));
            }
        };
        repos
            .into_iter()
            .filter(|r| {
                r.get("full_name")
                    .and_then(|v| v.as_str())
                    .map(|full_name| allowed.contains(full_name))
                    .unwrap_or(false)
            })
            .collect()
    };

    HttpResponse::Ok().json(serde_json::json!({
        "unrestricted": unrestricted,
        "repos": repos,
    }))
}

/// List the repositories the "Import all repositories" button can pull in.
/// Personal callers use their own token and never fall back to the shared token's
/// repos; organization callers get public repos only, platform callers get all.
#[get("/github-importable-repos")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_importable_repos(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized().finish();
    };
    let ctx = match resolve_role_context_moded(&req, pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!(target: "auth", user_id, error = ?e, "importable repos rbac resolution failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    if ctx.role == Role::Guest {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "message": "You don't have access to repositories"
        }));
    }

    if ctx.scope == Scope::Personal {
        let Some(user_token) = crate::github_oauth::stored_token_for(pool.get_ref(), user_id).await
        else {
            // Prompt to connect rather than exposing the shared token's repos.
            return HttpResponse::Ok().json(serde_json::json!({ "connected": false, "repos": [] }));
        };
        return match list_repos(Some(&user_token)).await {
            Ok(repos) => {
                HttpResponse::Ok().json(serde_json::json!({ "connected": true, "repos": repos }))
            }
            Err(()) => HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Couldn't reach GitHub" })),
        };
    }

    let public_only = ctx.scope != Scope::Platform;
    let repos = match list_repos(token().as_deref()).await {
        Ok(repos) => repos,
        Err(()) => {
            return HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Couldn't reach GitHub"
            }));
        }
    };
    let visible: Vec<serde_json::Value> = if public_only {
        repos
            .into_iter()
            .filter(|r| !r.get("private").and_then(|p| p.as_bool()).unwrap_or(false))
            .collect()
    } else {
        repos
    };
    HttpResponse::Ok().json(serde_json::json!({ "connected": true, "repos": visible }))
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_proxy);
    cfg.service(github_importable_repos);
    cfg.service(approve_pull_request);
    cfg.service(merge_pull_request);
    cfg.service(create_commit_comment);
    cfg.service(visible_projects);
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
        assert_eq!(
            build_merge_body(br#"{"merge_method":"REBASE"}"#)["merge_method"],
            "rebase"
        );
    }

    #[test]
    fn merge_body_rejects_unknown_method() {
        assert_eq!(
            build_merge_body(br#"{"merge_method":"yolo"}"#)["merge_method"],
            "merge"
        );
    }
}
