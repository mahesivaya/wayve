//! Projects and teams shown in the app sidebar.
//!
//! Teams are organization-scoped. Projects are polymorphic-owned: an
//! organization owner creates org projects (visible to the whole org), and a
//! **personal account** owns its own projects keyed on `user_id`. A personal
//! project may link ONE public GitHub repo (`github_owner`/`github_repo`),
//! browsed in the Code Repo viewer. Org-project creation stays locked to the
//! organization OWNER via [`rbac::require_owner`]; personal users manage only
//! their own projects. Platform accounts keep the legacy single-repo view and
//! do not own projects here.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use actix_web::{delete, patch};
use sqlx::Row;
use std::time::Duration;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Scope};

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    /// Optional public GitHub repo URL to link at creation (personal accounts).
    pub repo_url: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateProjectInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct LinkRepoInput {
    pub repo_url: String,
}

#[derive(Deserialize)]
pub struct CreateTeamInput {
    pub name: String,
    pub tagline: Option<String>,
    pub description: Option<String>,
}

const NAME_MAX: usize = 120;
const TAGLINE_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 2000;

/// Lowercase, ASCII-alphanumeric slug — mirrors the org slug rule in init.sql.
fn slugify(name: &str) -> String {
    let slug: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect();
    if slug.is_empty() {
        "team".to_string()
    } else {
        slug
    }
}

/// First slug of the form `base`, `base-2`, `base-3`, … not already present in
/// `taken`. Keeps team slugs unique within an org without relying on a retry
/// loop against the unique constraint.
fn pick_free_slug(base: &str, taken: &[String]) -> String {
    if !taken.contains(&base.to_string()) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The caller's home organization id, or `None` for personal / platform
/// accounts that don't belong to one.
// Which teams the caller can see: an org member sees their org's teams; a
// platform owner sees platform-level teams (organization_id IS NULL).
enum TeamScope {
    Org(i32),
    Platform,
    None,
}

async fn caller_team_scope(req: &HttpRequest, pool: &PgPool) -> Result<TeamScope, AppError> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool, user_id)
        .await
        .map_err(AppError::Db)?;
    Ok(match ctx.scope {
        Scope::Organization => ctx.organization_id.map_or(TeamScope::None, TeamScope::Org),
        Scope::Platform => TeamScope::Platform,
        Scope::Personal => TeamScope::None,
    })
}

/// Shared shape for a project row, including its optional linked repo.
fn project_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "github_owner": row.get::<Option<String>, _>("github_owner"),
        "github_repo": row.get::<Option<String>, _>("github_repo"),
    })
}

/// Server-held PAT for the GitHub proxy / repo validation. Optional — without
/// it we still validate, just against the 60/hr anonymous rate limit.
fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn is_valid_owner(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_valid_repo(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Pull `(owner, repo)` out of any common GitHub reference: a full
/// `https://github.com/owner/repo[/...|.git]`, an `git@github.com:owner/repo.git`
/// SSH URL, a bare `github.com/owner/repo`, or just `owner/repo`. Returns
/// `None` if it doesn't look like a GitHub repo path.
fn parse_repo_url(raw: &str) -> Option<(String, String)> {
    let s = raw.trim();
    // SSH form first (it has no scheme to strip).
    let rest = if let Some(ssh) = s.strip_prefix("git@github.com:") {
        ssh
    } else {
        let no_scheme = s
            .strip_prefix("https://")
            .or_else(|| s.strip_prefix("http://"))
            .unwrap_or(s);
        let no_www = no_scheme.strip_prefix("www.").unwrap_or(no_scheme);
        no_www.strip_prefix("github.com/").unwrap_or(no_www)
    };

    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !is_valid_owner(owner) || !is_valid_repo(repo) {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Parse a pasted repo URL and confirm with GitHub that it exists and is
/// **public**. Returns the canonical owner/name casing from GitHub. Any failure
/// is a 400 with a caller-safe message.
async fn parse_and_validate_repo(raw: &str) -> Result<(String, String), AppError> {
    let (owner, repo) = parse_repo_url(raw)
        .ok_or_else(|| AppError::bad_request("Not a valid GitHub repository URL"))?;

    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let mut builder = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");
    if let Some(pat) = github_token() {
        builder = builder.header("Authorization", format!("Bearer {pat}"));
    }

    let resp = builder.send().await.map_err(|e| {
        warn!(target: "http", error = ?e, "github repo validation call failed");
        AppError::bad_request("Could not reach GitHub to verify the repository")
    })?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::bad_request("Repository not found or not public"));
    }
    if !resp.status().is_success() {
        return Err(AppError::bad_request(
            "GitHub rejected the repository lookup",
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| AppError::bad_request("Unexpected response from GitHub"))?;
    if body
        .get("private")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
    {
        return Err(AppError::bad_request(
            "Only public repositories can be added",
        ));
    }

    let owner_canon = body
        .get("owner")
        .and_then(|o| o.get("login"))
        .and_then(|v| v.as_str())
        .unwrap_or(&owner)
        .to_string();
    let repo_canon = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&repo)
        .to_string();
    Ok((owner_canon, repo_canon))
}

// GET /api/projects — projects for the caller (org members see org projects;
// personal accounts see their own), newest first.
#[get("/projects")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_projects(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;

    // Org members see their org's projects; personal accounts see their own.
    // Platform accounts don't own projects here (legacy single-repo view).
    let rows = match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::Ok().json(serde_json::json!([])));
            };
            sqlx::query(
                "SELECT id, name, github_owner, github_repo
                 FROM projects
                 WHERE organization_id = $1
                 ORDER BY created_at DESC, id DESC",
            )
            .bind(org_id)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Personal => {
            sqlx::query(
                "SELECT id, name, github_owner, github_repo
                 FROM projects
                 WHERE user_id = $1 AND organization_id IS NULL
                 ORDER BY created_at DESC, id DESC",
            )
            .bind(user_id)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Platform => return Ok(HttpResponse::Ok().json(serde_json::json!([]))),
    };

    let projects: Vec<_> = rows.iter().map(project_json).collect();
    Ok(HttpResponse::Ok().json(projects))
}

// POST /api/projects — create a project. Org owners create org projects;
// personal accounts create their own (optionally linking a public repo).
#[post("/projects")]
#[instrument(target = "http", skip(req, pool, input))]
pub async fn create_project(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    input: web::Json<CreateProjectInput>,
) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is too long" })));
    }

    let row = match ctx.scope {
        Scope::Personal => {
            // Personal accounts own projects via user_id; an optional repo URL
            // is validated (public-only) before storing.
            let (gh_owner, gh_repo) = match input.repo_url.as_deref().map(str::trim) {
                Some(raw) if !raw.is_empty() => {
                    let (o, r) = parse_and_validate_repo(raw).await?;
                    (Some(o), Some(r))
                }
                _ => (None, None),
            };
            sqlx::query(
                "INSERT INTO projects (user_id, name, github_owner, github_repo, created_by)
                 VALUES ($1, $2, $3, $4, $1)
                 RETURNING id, name, github_owner, github_repo",
            )
            .bind(user_id)
            .bind(name)
            .bind(gh_owner)
            .bind(gh_repo)
            .fetch_one(pool.get_ref())
            .await?
        }
        Scope::Organization => {
            // Org projects stay locked to the organization owner.
            let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
                Ok(ctx) => ctx,
                Err(response) => return Ok(response),
            };
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            };
            sqlx::query(
                "INSERT INTO projects (organization_id, name, created_by)
                 VALUES ($1, $2, $3)
                 RETURNING id, name, github_owner, github_repo",
            )
            .bind(org_id)
            .bind(name)
            .bind(ctx.user_id)
            .fetch_one(pool.get_ref())
            .await?
        }
        Scope::Platform => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Platform accounts cannot create projects"
            })));
        }
    };

    Ok(HttpResponse::Created().json(project_json(&row)))
}

// PATCH /api/projects/{id} — rename a project. Org owners rename org projects;
// personal accounts rename their own.
#[patch("/projects/{id}")]
#[instrument(target = "http", skip(req, pool, path, input))]
pub async fn update_project(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    input: web::Json<UpdateProjectInput>,
) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is too long" })));
    }
    let id = path.into_inner();

    // Scoped UPDATE — a project the caller doesn't own won't match, so we 404
    // rather than leak that the id exists.
    let row = match ctx.scope {
        Scope::Personal => {
            sqlx::query(
                "UPDATE projects SET name = $1
                 WHERE id = $2 AND user_id = $3 AND organization_id IS NULL
                 RETURNING id, name, github_owner, github_repo",
            )
            .bind(name)
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?
        }
        Scope::Organization => {
            let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
                Ok(ctx) => ctx,
                Err(response) => return Ok(response),
            };
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            };
            sqlx::query(
                "UPDATE projects SET name = $1
                 WHERE id = $2 AND organization_id = $3
                 RETURNING id, name, github_owner, github_repo",
            )
            .bind(name)
            .bind(id)
            .bind(org_id)
            .fetch_optional(pool.get_ref())
            .await?
        }
        Scope::Platform => {
            return Ok(HttpResponse::Forbidden()
                .json(serde_json::json!({ "message": "Platform accounts cannot edit projects" })));
        }
    };

    match row {
        Some(row) => Ok(HttpResponse::Ok().json(project_json(&row))),
        None => Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Project not found" }))
        ),
    }
}

// PATCH /api/projects/{id}/repo — link (or replace) the public GitHub repo on a
// personal account's project. Personal accounts only.
#[patch("/projects/{id}/repo")]
#[instrument(target = "http", skip(req, pool, path, input))]
pub async fn link_project_repo(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    input: web::Json<LinkRepoInput>,
) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;
    if ctx.scope != Scope::Personal {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Linking a repository is available to personal accounts"
        })));
    }

    let (owner, repo) = parse_and_validate_repo(input.repo_url.trim()).await?;

    let row = sqlx::query(
        "UPDATE projects SET github_owner = $1, github_repo = $2
         WHERE id = $3 AND user_id = $4 AND organization_id IS NULL
         RETURNING id, name, github_owner, github_repo",
    )
    .bind(&owner)
    .bind(&repo)
    .bind(path.into_inner())
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    match row {
        Some(row) => Ok(HttpResponse::Ok().json(project_json(&row))),
        None => Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Project not found" }))
        ),
    }
}

// DELETE /api/projects/{id} — delete a project. Org owners delete org projects;
// personal accounts delete their own. The linked repo columns go with the row.
#[delete("/projects/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_project(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;
    let id = path.into_inner();

    // Scoped DELETE — a project the caller doesn't own won't match, so we 404
    // rather than leak that the id exists.
    let row = match ctx.scope {
        Scope::Personal => {
            sqlx::query(
                "DELETE FROM projects
                 WHERE id = $1 AND user_id = $2 AND organization_id IS NULL
                 RETURNING id",
            )
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?
        }
        Scope::Organization => {
            let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
                Ok(ctx) => ctx,
                Err(response) => return Ok(response),
            };
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            };
            sqlx::query("DELETE FROM projects WHERE id = $1 AND organization_id = $2 RETURNING id")
                .bind(id)
                .bind(org_id)
                .fetch_optional(pool.get_ref())
                .await?
        }
        Scope::Platform => {
            return Ok(HttpResponse::Forbidden().json(
                serde_json::json!({ "message": "Platform accounts cannot delete projects" }),
            ));
        }
    };

    match row {
        Some(_) => Ok(HttpResponse::NoContent().finish()),
        None => Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Project not found" }))
        ),
    }
}

// GET /api/teams — teams for the caller's org, newest first.
#[get("/teams")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_teams(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let rows = match caller_team_scope(&req, pool.get_ref()).await? {
        TeamScope::Org(org_id) => {
            sqlx::query(
                "SELECT id, name, slug, tagline, description, created_at
                 FROM teams
                 WHERE organization_id = $1
                 ORDER BY created_at DESC, id DESC",
            )
            .bind(org_id)
            .fetch_all(pool.get_ref())
            .await?
        }
        TeamScope::Platform => {
            sqlx::query(
                "SELECT id, name, slug, tagline, description, created_at
                 FROM teams
                 WHERE organization_id IS NULL
                 ORDER BY created_at DESC, id DESC",
            )
            .fetch_all(pool.get_ref())
            .await?
        }
        TeamScope::None => return Ok(HttpResponse::Ok().json(serde_json::json!([]))),
    };

    let teams: Vec<_> = rows.into_iter().map(team_summary_json).collect();
    Ok(HttpResponse::Ok().json(teams))
}

// GET /api/teams/{slug} — one team in the caller's org (for the detail page).
#[get("/teams/{slug}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_team(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> AppResult {
    let slug = path.into_inner();
    let row = match caller_team_scope(&req, pool.get_ref()).await? {
        TeamScope::Org(org_id) => {
            sqlx::query(
                "SELECT id, name, slug, tagline, description, created_at
                 FROM teams
                 WHERE organization_id = $1 AND slug = $2",
            )
            .bind(org_id)
            .bind(&slug)
            .fetch_optional(pool.get_ref())
            .await?
        }
        TeamScope::Platform => {
            sqlx::query(
                "SELECT id, name, slug, tagline, description, created_at
                 FROM teams
                 WHERE organization_id IS NULL AND slug = $1",
            )
            .bind(&slug)
            .fetch_optional(pool.get_ref())
            .await?
        }
        TeamScope::None => None,
    };

    match row {
        Some(row) => Ok(HttpResponse::Ok().json(team_summary_json(row))),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Team not found" })))
        }
    }
}

// POST /api/teams — create a team (org owner only).
#[post("/teams")]
#[instrument(target = "http", skip(req, pool, input))]
pub async fn create_team(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    input: web::Json<CreateTeamInput>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    // An organization owner creates a team inside their org; a platform owner
    // creates a platform-level team (organization_id = NULL).
    let org_id: Option<i32> = match ctx.scope {
        Scope::Organization => match ctx.organization_id {
            Some(id) => Some(id),
            None => {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            }
        },
        Scope::Platform => None,
        Scope::Personal => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Only an organization or platform owner can create teams"
            })));
        }
    };

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Team name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Team name is too long" })));
    }
    let tagline = clean_optional(input.tagline.as_deref(), TAGLINE_MAX);
    let description = clean_optional(input.description.as_deref(), DESCRIPTION_MAX);

    // Choose a slug unique within the scope (org, or the platform-team set when
    // org_id is NULL) before inserting. IS NOT DISTINCT FROM makes NULL = NULL.
    let base = slugify(name);
    let taken: Vec<String> = sqlx::query_scalar(
        "SELECT slug FROM teams WHERE organization_id IS NOT DISTINCT FROM $1 AND (slug = $2 OR slug LIKE $2 || '-%')",
    )
    .bind(org_id)
    .bind(&base)
    .fetch_all(pool.get_ref())
    .await?;
    let slug = pick_free_slug(&base, &taken);

    let row = sqlx::query(
        "INSERT INTO teams (organization_id, name, slug, tagline, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, slug, tagline, description, created_at",
    )
    .bind(org_id)
    .bind(name)
    .bind(&slug)
    .bind(tagline.as_deref())
    .bind(description.as_deref())
    .bind(ctx.user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(team_summary_json(row)))
}

fn clean_optional(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(max).collect())
}

fn team_summary_json(row: sqlx::postgres::PgRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "slug": row.get::<String, _>("slug"),
        "tagline": row.get::<Option<String>, _>("tagline"),
        "description": row.get::<Option<String>, _>("description"),
    })
}
