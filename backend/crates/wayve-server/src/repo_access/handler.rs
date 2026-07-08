//! Endpoints for the per-repo Access panel:
//!   GET    /api/repos/{owner}/{repo}/access        → the access grid
//!   PUT    /api/repos/{owner}/{repo}/access        → add/update one user's access
//!   DELETE /api/repos/{owner}/{repo}/access?user_id=|login=  → remove access
//!
//! Access gate (all three): the caller must be able to administer the repo —
//! an **org** owner/admin (MembersManage) for a repo linked to their org, a
//! **platform** owner/admin, or a **personal** user for their own linked repo.
//! Viewing needs MembersRead; mutating needs MembersManage.

use crate::prelude::*;
use actix_web::{delete, put};
use std::collections::{HashMap, HashSet};
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Permission, Scope, resolve_role_context};

use super::github::{self, Level, SyncOutcome};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_access)
        .service(set_access)
        .service(remove_access);
}

/// Resolved authorization for a repo-access request.
struct RepoAdmin {
    user_id: i32,
    /// Whether the caller may *mutate* access (MembersManage / owns the repo).
    can_manage: bool,
}

/// Verify the caller may view access for `owner/repo`, and compute whether they
/// may also manage it. Scoping mirrors `github_proxy::authorize_github_access`
/// and `workspace::list_projects` so this never widens what a caller can reach.
async fn authorize(
    req: &HttpRequest,
    pool: &PgPool,
    owner: &str,
    repo: &str,
) -> Result<RepoAdmin, AppError> {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let ctx = resolve_role_context(pool, user_id).await?;

    match ctx.scope {
        Scope::Organization => {
            let org_id = ctx.organization_id.ok_or(AppError::Forbidden)?;
            if !ctx.has(Permission::MembersRead) {
                return Err(AppError::Forbidden);
            }
            let linked = repo_is_org_project(pool, org_id, owner, repo).await?;
            if !linked {
                return Err(AppError::NotFound("repository"));
            }
            Ok(RepoAdmin {
                user_id,
                can_manage: ctx.has(Permission::MembersManage),
            })
        }
        Scope::Platform => {
            if !ctx.has(Permission::MembersRead) {
                return Err(AppError::Forbidden);
            }
            Ok(RepoAdmin {
                user_id,
                can_manage: ctx.has(Permission::MembersManage),
            })
        }
        Scope::Personal => {
            let linked = repo_is_personal_project(pool, user_id, owner, repo).await?;
            if !linked {
                return Err(AppError::NotFound("repository"));
            }
            // A personal user administers their own linked repo.
            Ok(RepoAdmin {
                user_id,
                can_manage: true,
            })
        }
    }
}

async fn repo_is_org_project(
    pool: &PgPool,
    org_id: i32,
    owner: &str,
    repo: &str,
) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects
          WHERE organization_id = $1 AND user_id IS NULL
            AND LOWER(github_owner) = LOWER($2) AND LOWER(github_repo) = LOWER($3))",
    )
    .bind(org_id)
    .bind(owner)
    .bind(repo)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

async fn repo_is_personal_project(
    pool: &PgPool,
    user_id: i32,
    owner: &str,
    repo: &str,
) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects
          WHERE user_id = $1 AND organization_id IS NULL
            AND LOWER(github_owner) = LOWER($2) AND LOWER(github_repo) = LOWER($3))",
    )
    .bind(user_id)
    .bind(owner)
    .bind(repo)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

// ───────────────────────────── read model ─────────────────────────────

#[derive(Serialize)]
struct AccessRow {
    /// Wayve user id when the person maps to a connected member; null for a
    /// GitHub-only collaborator.
    user_id: Option<i32>,
    github_login: Option<String>,
    email: Option<String>,
    /// read | write | admin — GitHub's live level when they're a collaborator,
    /// else the Wayve-recorded grant level.
    level: String,
    /// Whether the repo shows in this user's Wayve dashboard (has a grant).
    in_dashboard: bool,
    /// Whether the person maps to a Wayve user (assignable) vs. GitHub-only.
    is_member: bool,
    /// github | wayve | both — where the access comes from.
    source: String,
}

#[derive(Serialize)]
struct AccessResponse {
    repo: String,
    /// Whether we could read collaborators from GitHub (false → grid shows only
    /// the Wayve grants + a hint).
    github_readable: bool,
    can_manage: bool,
    rows: Vec<AccessRow>,
}

#[get("/repos/{owner}/{repo}/access")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_access(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String)>,
) -> AppResult {
    let (owner, repo) = path.into_inner();
    let pool = pool.get_ref();
    let admin = authorize(&req, pool, &owner, &repo).await?;
    let token = crate::github_proxy::effective_github_token(&req, pool).await;

    // Live GitHub collaborators (best-effort — degrade to Wayve grants alone).
    let (collabs, github_readable) = match github::list_collaborators(
        &owner,
        &repo,
        token.as_deref(),
    )
    .await
    {
        Ok(c) => (c, true),
        Err(e) => {
            warn!(target: "worker", %owner, %repo, error = %e, "collaborators unreadable; showing grants only");
            (Vec::new(), false)
        }
    };

    // Wayve dashboard grants for this repo.
    let full = format!("{owner}/{repo}");
    let grant_rows = sqlx::query(
        "SELECT user_id, access_level FROM member_project_access WHERE repo_full_name = $1",
    )
    .bind(&full)
    .fetch_all(pool)
    .await?;
    let mut grant_by_user: HashMap<i32, String> = HashMap::new();
    for r in &grant_rows {
        grant_by_user.insert(
            r.get::<i32, _>("user_id"),
            r.get::<String, _>("access_level"),
        );
    }

    // Map collaborator logins → Wayve users.
    let logins: Vec<String> = collabs
        .iter()
        .map(|c| c.login.to_ascii_lowercase())
        .collect();
    let login_to_user = users_by_login(pool, &logins).await?;

    // For grant users not covered by a collaborator, resolve email + login.
    let grant_user_ids: Vec<i32> = grant_by_user.keys().copied().collect();
    let user_meta = users_by_id(pool, &grant_user_ids).await?;

    let mut rows: Vec<AccessRow> = Vec::new();
    let mut covered_users: HashSet<i32> = HashSet::new();

    // 1. A row per GitHub collaborator (level is GitHub-authoritative).
    for c in &collabs {
        let mapped = login_to_user.get(&c.login.to_ascii_lowercase());
        let uid = mapped.map(|m| m.0);
        let in_dashboard = uid.map(|u| grant_by_user.contains_key(&u)).unwrap_or(false);
        if let Some(u) = uid {
            covered_users.insert(u);
        }
        let source = if in_dashboard { "both" } else { "github" };
        rows.push(AccessRow {
            user_id: uid,
            github_login: Some(c.login.clone()),
            email: mapped.map(|m| m.1.clone()),
            level: c.level.as_str().to_string(),
            in_dashboard,
            is_member: uid.is_some(),
            source: source.to_string(),
        });
    }

    // 2. A row per Wayve grant that isn't already a collaborator above.
    for (uid, level) in &grant_by_user {
        if covered_users.contains(uid) {
            continue;
        }
        let meta = user_meta.get(uid);
        rows.push(AccessRow {
            user_id: Some(*uid),
            github_login: meta.and_then(|m| m.1.clone()),
            email: meta.map(|m| m.0.clone()),
            level: level.clone(),
            in_dashboard: true,
            is_member: true,
            source: "wayve".to_string(),
        });
    }

    Ok(HttpResponse::Ok().json(AccessResponse {
        repo: full,
        github_readable,
        can_manage: admin.can_manage,
        rows,
    }))
}

/// login(lowercased) → (user_id, email) for connected members.
async fn users_by_login(
    pool: &PgPool,
    logins: &[String],
) -> Result<HashMap<String, (i32, String)>, AppError> {
    if logins.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT LOWER(ga.github_login) AS login, ga.user_id, u.email
         FROM github_accounts ga JOIN users u ON u.id = ga.user_id
         WHERE LOWER(ga.github_login) = ANY($1)",
    )
    .bind(logins)
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::new();
    for r in rows {
        map.insert(
            r.get::<String, _>("login"),
            (r.get::<i32, _>("user_id"), r.get::<String, _>("email")),
        );
    }
    Ok(map)
}

/// user_id → (email, github_login?) for the given users.
async fn users_by_id(
    pool: &PgPool,
    ids: &[i32],
) -> Result<HashMap<i32, (String, Option<String>)>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT u.id, u.email, ga.github_login
         FROM users u LEFT JOIN github_accounts ga ON ga.user_id = u.id
         WHERE u.id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::new();
    for r in rows {
        map.insert(
            r.get::<i32, _>("id"),
            (
                r.get::<String, _>("email"),
                r.try_get::<Option<String>, _>("github_login")
                    .ok()
                    .flatten(),
            ),
        );
    }
    Ok(map)
}

// ───────────────────────────── write model ─────────────────────────────

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub struct SetAccessInput {
    #[serde(default)]
    pub user_id: Option<i32>,
    #[serde(default)]
    pub github_login: Option<String>,
    /// "read" | "write".
    pub level: String,
    /// Grant Wayve dashboard visibility (default true). When false, only the
    /// GitHub collaborator side is touched.
    #[serde(default = "default_true")]
    pub in_dashboard: bool,
}

#[derive(Serialize)]
struct MutateResponse {
    dashboard_updated: bool,
    /// synced | forbidden | failed | skipped
    github_outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

fn outcome_str(o: SyncOutcome) -> &'static str {
    match o {
        SyncOutcome::Synced => "synced",
        SyncOutcome::Forbidden => "forbidden",
        SyncOutcome::Failed => "failed",
    }
}

fn note_for(o: SyncOutcome, had_login: bool) -> Option<String> {
    if !had_login {
        return Some(
            "This member hasn't connected GitHub, so only their Wayve dashboard access was changed."
                .into(),
        );
    }
    match o {
        SyncOutcome::Forbidden => Some(
            "GitHub wasn't changed — the connected token lacks admin permission on this repository."
                .into(),
        ),
        SyncOutcome::Failed => Some("Couldn't reach GitHub to change the collaborator.".into()),
        SyncOutcome::Synced => None,
    }
}

#[put("/repos/{owner}/{repo}/access")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn set_access(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String)>,
    body: web::Json<SetAccessInput>,
) -> AppResult {
    let (owner, repo) = path.into_inner();
    let pool = pool.get_ref();
    let admin = authorize(&req, pool, &owner, &repo).await?;
    if !admin.can_manage {
        return Err(AppError::Forbidden);
    }
    let level = Level::parse(&body.level)
        .ok_or_else(|| AppError::bad_request("level must be 'read' or 'write'"))?;
    if matches!(level, Level::Admin) {
        return Err(AppError::bad_request("cannot grant admin from here"));
    }

    // Resolve the target's Wayve user_id and GitHub login (either may be absent).
    let (user_id, login) = resolve_target(pool, body.user_id, body.github_login.as_deref()).await?;
    if user_id.is_none() && login.is_none() {
        return Err(AppError::bad_request("provide user_id or github_login"));
    }

    let full = format!("{owner}/{repo}");
    let mut dashboard_updated = false;

    // Wayve dashboard grant (only possible for a known Wayve user).
    if let Some(uid) = user_id {
        if body.in_dashboard {
            sqlx::query(
                "INSERT INTO member_project_access (user_id, repo_full_name, granted_by, access_level)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, repo_full_name)
                 DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by",
            )
            .bind(uid)
            .bind(&full)
            .bind(admin.user_id)
            .bind(level.as_str())
            .execute(pool)
            .await?;
        } else {
            sqlx::query(
                "DELETE FROM member_project_access WHERE user_id = $1 AND repo_full_name = $2",
            )
            .bind(uid)
            .bind(&full)
            .execute(pool)
            .await?;
        }
        dashboard_updated = true;
    }

    // Best-effort GitHub collaborator sync (needs an admin token + a login).
    let token = crate::github_proxy::effective_github_token(&req, pool).await;
    let github_outcome = match &login {
        Some(l) => github::add_collaborator(&owner, &repo, l, level, token.as_deref()).await,
        None => SyncOutcome::Forbidden, // no login to act on
    };
    let github_str = if login.is_none() {
        "skipped"
    } else {
        outcome_str(github_outcome)
    };

    crate::audit::record_action(
        pool,
        &req,
        crate::audit::AuditEvent {
            actor_user_id: admin.user_id,
            action: "repo_access_change",
            resource_type: "repo",
            resource_id: Some(full.clone()),
            metadata: Some(serde_json::json!({
                "repo": full, "user_id": user_id, "github_login": login,
                "level": level.as_str(), "in_dashboard": body.in_dashboard,
                "github_outcome": github_str,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(MutateResponse {
        dashboard_updated,
        github_outcome: github_str.to_string(),
        note: note_for(github_outcome, login.is_some()),
    }))
}

#[derive(Deserialize)]
pub struct RemoveQuery {
    #[serde(default)]
    pub user_id: Option<i32>,
    #[serde(default)]
    pub login: Option<String>,
}

#[delete("/repos/{owner}/{repo}/access")]
#[instrument(target = "http", skip(req, pool, q))]
pub async fn remove_access(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(String, String)>,
    q: web::Query<RemoveQuery>,
) -> AppResult {
    let (owner, repo) = path.into_inner();
    let pool = pool.get_ref();
    let admin = authorize(&req, pool, &owner, &repo).await?;
    if !admin.can_manage {
        return Err(AppError::Forbidden);
    }
    let (user_id, login) = resolve_target(pool, q.user_id, q.login.as_deref()).await?;
    if user_id.is_none() && login.is_none() {
        return Err(AppError::bad_request("provide user_id or login"));
    }

    let full = format!("{owner}/{repo}");
    let mut dashboard_updated = false;
    if let Some(uid) = user_id {
        sqlx::query("DELETE FROM member_project_access WHERE user_id = $1 AND repo_full_name = $2")
            .bind(uid)
            .bind(&full)
            .execute(pool)
            .await?;
        dashboard_updated = true;
    }

    let token = crate::github_proxy::effective_github_token(&req, pool).await;
    let github_outcome = match &login {
        Some(l) => github::remove_collaborator(&owner, &repo, l, token.as_deref()).await,
        None => SyncOutcome::Forbidden,
    };
    let github_str = if login.is_none() {
        "skipped"
    } else {
        outcome_str(github_outcome)
    };

    crate::audit::record_action(
        pool,
        &req,
        crate::audit::AuditEvent {
            actor_user_id: admin.user_id,
            action: "repo_access_remove",
            resource_type: "repo",
            resource_id: Some(full.clone()),
            metadata: Some(serde_json::json!({
                "repo": full, "user_id": user_id, "github_login": login,
                "github_outcome": github_str,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(MutateResponse {
        dashboard_updated,
        github_outcome: github_str.to_string(),
        note: note_for(github_outcome, login.is_some()),
    }))
}

/// Fill in the missing half of (user_id, login): given a user_id, look up their
/// GitHub login; given a login, look up their Wayve user. Either side may stay
/// `None` (unconnected member, or GitHub-only collaborator).
async fn resolve_target(
    pool: &PgPool,
    user_id: Option<i32>,
    login: Option<&str>,
) -> Result<(Option<i32>, Option<String>), AppError> {
    if let Some(uid) = user_id {
        let l: Option<String> =
            sqlx::query_scalar("SELECT github_login FROM github_accounts WHERE user_id = $1")
                .bind(uid)
                .fetch_optional(pool)
                .await?
                .flatten();
        return Ok((Some(uid), l.or_else(|| login.map(str::to_string))));
    }
    if let Some(l) = login {
        let uid: Option<i32> = sqlx::query_scalar(
            "SELECT user_id FROM github_accounts WHERE LOWER(github_login) = LOWER($1)",
        )
        .bind(l)
        .fetch_optional(pool)
        .await?;
        return Ok((uid, Some(l.to_string())));
    }
    Ok((None, None))
}
