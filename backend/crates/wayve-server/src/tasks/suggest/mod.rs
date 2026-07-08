//! Assignee suggestion: given a task on a project, rank the people who have
//! worked in the files the task will likely touch.
//!
//! Pipeline (see docs/architecture/ai-task-assignment.md):
//!   project → repo → file tree → [map story→files] → per-file commit authors
//!   → recency-weighted scores → match GitHub logins to Wayve users.
//!
//! Read-only and idempotent — it never assigns the task; the caller saves the
//! chosen assignee via the normal task update.

pub mod github;
pub mod mapping;
pub mod scoring;

use crate::prelude::*;
use futures::future::join_all;
use sqlx::Row;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Scope, resolve_role_context};

/// Max candidates returned to the UI.
const MAX_CANDIDATES: usize = 10;

#[derive(Deserialize)]
pub struct SuggestInput {
    pub project_id: i32,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Serialize)]
struct Candidate {
    /// Wayve user id when the GitHub author maps to a connected member; null for
    /// reference-only contributors.
    user_id: Option<i32>,
    github_login: Option<String>,
    /// Best display label: member email, else GitHub login, else commit name.
    display: String,
    email: Option<String>,
    /// True when this person can't be assigned (no linked Wayve account) — the
    /// UI shows them as a reference name only.
    is_reference_only: bool,
    expertise_score: f64,
    commits: u32,
    recent_commits: u32,
    last_activity: Option<String>,
    reason: String,
}

#[derive(Serialize)]
struct SuggestResponse {
    /// Whether the AI produced the file mapping (vs. the keyword fallback).
    used_ai: bool,
    /// The files the task was mapped to (what the ranking is based on).
    files: Vec<String>,
    candidates: Vec<Candidate>,
    /// Set when we can't suggest (e.g. project not linked to a repo) so the UI
    /// can explain the empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(suggest_assignee);
}

/// The `(github_owner, github_repo)` for a project the caller may access, or an
/// error. `Ok(None)` when the project exists but isn't linked to a repo.
async fn project_repo(
    pool: &PgPool,
    user_id: i32,
    project_id: i32,
) -> Result<Option<(String, String)>, AppError> {
    let ctx = resolve_role_context(pool, user_id).await?;
    // Scope the lookup exactly like GET /api/projects so a caller can only
    // resolve a project in their own org (or their own personal projects).
    let row = match ctx.scope {
        Scope::Organization => {
            let org_id = ctx.organization_id.ok_or(AppError::NotFound("project"))?;
            sqlx::query(
                "SELECT github_owner, github_repo FROM projects
                 WHERE id = $1 AND organization_id = $2",
            )
            .bind(project_id)
            .bind(org_id)
            .fetch_optional(pool)
            .await?
        }
        Scope::Personal => {
            sqlx::query(
                "SELECT github_owner, github_repo FROM projects
                 WHERE id = $1 AND user_id = $2 AND organization_id IS NULL",
            )
            .bind(project_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?
        }
        Scope::Platform => None,
    };

    let row = row.ok_or(AppError::NotFound("project"))?;
    let owner: Option<String> = row.try_get("github_owner").ok().flatten();
    let repo: Option<String> = row.try_get("github_repo").ok().flatten();
    match (owner, repo) {
        (Some(o), Some(r)) if !o.is_empty() && !r.is_empty() => Ok(Some((o, r))),
        _ => Ok(None),
    }
}

/// user_ids the caller may assign to (their org's members, or platform staff).
/// A matched GitHub author is only "assignable" if their Wayve id is in here —
/// otherwise they're a reference name, even if they've connected GitHub.
async fn assignable_ids(
    pool: &PgPool,
    user_id: i32,
) -> Result<std::collections::HashSet<i32>, AppError> {
    let ctx = resolve_role_context(pool, user_id).await?;
    let rows = match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(Default::default());
            };
            sqlx::query("SELECT id FROM users WHERE organization_id = $1")
                .bind(org_id)
                .fetch_all(pool)
                .await?
        }
        Scope::Platform => {
            sqlx::query("SELECT user_id AS id FROM platform_members")
                .fetch_all(pool)
                .await?
        }
        Scope::Personal => vec![],
    };
    Ok(rows.iter().map(|r| r.get::<i32, _>("id")).collect())
}

/// Map lowercased GitHub logins to their connected Wayve user (id, email,
/// username). Only self-connected users appear in `github_accounts`.
async fn logins_to_users(
    pool: &PgPool,
    logins: &[String],
) -> Result<std::collections::HashMap<String, (i32, String, Option<String>)>, AppError> {
    if logins.is_empty() {
        return Ok(Default::default());
    }
    let rows = sqlx::query(
        "SELECT ga.user_id, ga.github_login, u.email, u.username
         FROM github_accounts ga JOIN users u ON u.id = ga.user_id
         WHERE LOWER(ga.github_login) = ANY($1)",
    )
    .bind(logins)
    .fetch_all(pool)
    .await?;
    let mut map = std::collections::HashMap::new();
    for r in rows {
        let login: String = r.get("github_login");
        let uid: i32 = r.get("user_id");
        let email: String = r.get("email");
        let username: Option<String> = r.try_get("username").ok().flatten();
        map.insert(login.to_ascii_lowercase(), (uid, email, username));
    }
    Ok(map)
}

fn reason_for(commits: u32, recent: u32, files: usize) -> String {
    let files_note = if files > 1 {
        format!(" across {files} relevant files")
    } else {
        " in the relevant file".to_string()
    };
    if recent > 0 {
        format!(
            "{commits} commit{}{} ({recent} recent)",
            plural(commits),
            files_note
        )
    } else {
        format!("{commits} commit{}{}", plural(commits), files_note)
    }
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

#[post("/tasks/suggest-assignee")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn suggest_assignee(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<SuggestInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let pool = pool.get_ref();

    // 1. Resolve the project's repo (access-scoped).
    let Some((owner, repo)) = project_repo(pool, user_id, body.project_id).await? else {
        return Ok(HttpResponse::Ok().json(SuggestResponse {
            used_ai: false,
            files: vec![],
            candidates: vec![],
            note: Some("This project isn't linked to a GitHub repository.".into()),
        }));
    };

    // 2. Effective GitHub token for this caller (their own, or the shared PAT).
    let token = crate::github_proxy::effective_github_token(&req, pool).await;

    // 3. Repo file tree → map the story to likely files.
    let tree = match github::repo_file_paths(&owner, &repo, token.as_deref()).await {
        Ok(t) => t,
        Err(e) => {
            warn!(target: "worker", %owner, %repo, error = %e, "repo tree fetch failed");
            return Ok(HttpResponse::Ok().json(SuggestResponse {
                used_ai: false,
                files: vec![],
                candidates: vec![],
                note: Some("Couldn't read the repository from GitHub.".into()),
            }));
        }
    };
    let mapping =
        mapping::map_story_to_files(pool, user_id, &body.summary, &body.description, &tree).await;
    if mapping.files.is_empty() {
        return Ok(HttpResponse::Ok().json(SuggestResponse {
            used_ai: mapping.used_ai,
            files: vec![],
            candidates: vec![],
            note: Some("Couldn't match this task to any files in the repository.".into()),
        }));
    }

    // 4. Per-file commit authors (bounded — files is capped at MAX_FILES).
    let fetches = mapping.files.iter().map(|path| {
        let owner = owner.clone();
        let repo = repo.clone();
        let token = token.clone();
        async move { github::commits_for_path(&owner, &repo, path, token.as_deref()).await }
    });
    let mut all_commits = Vec::new();
    for res in join_all(fetches).await {
        match res {
            Ok(mut cs) => all_commits.append(&mut cs),
            Err(e) => warn!(target: "worker", error = %e, "commits_for_path failed; skipping file"),
        }
    }

    // 5. Score + rank authors.
    let ranked = scoring::rank_authors(&all_commits);

    // 6. Match logins → Wayve users, gate assignability to the caller's scope.
    let logins: Vec<String> = ranked
        .iter()
        .filter_map(|a| a.login.as_ref().map(|l| l.to_ascii_lowercase()))
        .collect();
    let users = logins_to_users(pool, &logins).await.unwrap_or_default();
    let assignable = assignable_ids(pool, user_id).await.unwrap_or_default();

    let file_count = mapping.files.len();
    let candidates: Vec<Candidate> = ranked
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|a| {
            let matched = a
                .login
                .as_ref()
                .and_then(|l| users.get(&l.to_ascii_lowercase()))
                .filter(|(uid, _, _)| assignable.contains(uid));
            let (user_id, email, is_ref) = match matched {
                Some((uid, email, _)) => (Some(*uid), Some(email.clone()), false),
                None => (None, None, true),
            };
            let display = email
                .clone()
                .or_else(|| a.login.clone())
                .or_else(|| a.name.clone())
                .unwrap_or_else(|| "Unknown".to_string());
            Candidate {
                user_id,
                github_login: a.login.clone(),
                display,
                email,
                is_reference_only: is_ref,
                expertise_score: a.score,
                commits: a.commits,
                recent_commits: a.recent_commits,
                last_activity: a.last_activity.map(|d| d.to_rfc3339()),
                reason: reason_for(a.commits, a.recent_commits, file_count),
            }
        })
        .collect();

    Ok(HttpResponse::Ok().json(SuggestResponse {
        used_ai: mapping.used_ai,
        files: mapping.files,
        candidates,
        note: None,
    }))
}
