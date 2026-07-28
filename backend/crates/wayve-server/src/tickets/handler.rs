//! Workspace tickets — a second org-shared board, independent of user stories,
//! that reuses the Tasks data shape and the Tasks UI (`frontend/src/tasks/Tasks.tsx`
//! via a config prop).
//!
//! Ownership is polymorphic exactly like `task_statuses`: an organization member
//! reads and writes their org's ONE shared list; platform and personal accounts
//! get their own. That owner comes from [`statuses::owner_for_user`], so a ticket
//! and the statuses it references always share the same owner — the board reuses
//! the owner's `task_statuses` set rather than duplicating a status table.
//!
//! Responses reuse [`Task`] (task_number carries the per-owner `ticket_number`;
//! the Jira/GitLab fields are always None), and requests reuse [`TaskInput`], so
//! the shared frontend component needs no new record type. This is NOT the
//! `support_tickets` feature — that is in-app support requests.

use crate::models::task::{Task, TaskInput};
use crate::prelude::*;
use crate::tasks::statuses::{self, StatusOwner};
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

/// Whether the caller may see and manage bug-report tickets — support tickets
/// mirrored onto the board (`support_ticket_id IS NOT NULL`). These are a
/// cross-tenant **platform** concern, so the caller must be in the Platform
/// scope AND hold `tickets:manage`. Scope matters because personal accounts
/// resolve to `(Personal, Owner)` and Owner carries every permission — without
/// the scope check a personal user would see every org's reports. In Normal
/// mode a platform admin is downscoped to Personal (admin console gate), so this
/// also naturally requires admin mode. Non-failing: any error resolves to false.
async fn can_manage_bug_tickets(req: &HttpRequest, pool: &PgPool, user_id: i32) -> bool {
    rbac::resolve_role_context_moded(req, pool, user_id)
        .await
        .map(|ctx| ctx.scope == Scope::Platform && ctx.has(Permission::TicketsManage))
        .unwrap_or(false)
}

/// The same platform + `tickets:manage` check, but from DB truth with NO
/// session-mode downscope. This is for **service** callers only: API keys are
/// forced to Normal mode (see `mode_from_request`), which would downscope even a
/// platform owner to member and make the mode-aware gate above always reject
/// them. The CI callbacks (`ai-fix-diff`, `resolution`) authenticate with an
/// internal key mapped to a platform tickets:manage user, so they must consult
/// the un-downscoped context. The api-key middleware has already validated the
/// key's scope before the request reaches here.
async fn can_manage_bug_tickets_service(pool: &PgPool, user_id: i32) -> bool {
    rbac::resolve_role_context(pool, user_id)
        .await
        .map(|ctx| ctx.scope == Scope::Platform && ctx.has(Permission::TicketsManage))
        .unwrap_or(false)
}

/// Resolve the caller and confirm `ticket_id` is within their visible scope
/// (own board, or a bug-derived ticket when they manage bugs). Returns the
/// caller's `user_id` on success, `NotFound` otherwise. Shared with the ticket
/// attachments module so it enforces the same visibility as the board.
pub(super) async fn ticket_visible_to(
    req: &HttpRequest,
    pool: &PgPool,
    ticket_id: i32,
) -> Result<i32, AppError> {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool, user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(req, pool, user_id).await;
    let found: Option<i32> = sqlx::query_scalar(&format!(
        "SELECT id FROM workspace_tickets WHERE id = $4 AND {VISIBLE_SCOPE}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(ticket_id)
    .fetch_optional(pool)
    .await?;
    found
        .map(|_| user_id)
        .ok_or(AppError::NotFound("workspace ticket"))
}

/// Splits the polymorphic owner into the two nullable binds every query uses.
fn owner_ids(owner: StatusOwner) -> (Option<i32>, Option<i32>) {
    match owner {
        StatusOwner::Organization(id) => (Some(id), None),
        StatusOwner::User(id) => (None, Some(id)),
    }
}

fn ticket_from_row(row: sqlx::postgres::PgRow) -> Task {
    Task {
        id: row.get("id"),
        task_number: row.try_get("ticket_number").ok().flatten(),
        name: row.get("name"),
        description: row.get("description"),
        priority: row.get("priority"),
        status: row.get("status"),
        assigned_by: row.try_get("assigned_by").unwrap_or_default(),
        assignee: row.try_get("assignee").unwrap_or_default(),
        assignee_id: row.try_get("assignee_id").ok().flatten(),
        project_id: row.try_get("project_id").ok().flatten(),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
        // Workspace tickets are never externally imported, so these stay unset.
        jira_issue_key: None,
        jira_base: None,
        gitlab_issue_iid: None,
        gitlab_web_url: None,
        // Present in the list/create/update queries; absent elsewhere.
        badge_kind: row.try_get("badge_kind").ok().flatten(),
        related_to: row.try_get("related_to").ok().flatten(),
        relation_kind: row.try_get("relation_kind").ok().flatten(),
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    value.unwrap_or(3).clamp(1, 5)
}

/// The stored value for a user-picked ticket type. Trims + lowercases, accepts
/// only the known set (mirrors the DB CHECK + support categories), and maps
/// anything empty/unknown to None so a bad value can never persist or 500.
fn normalize_badge_kind(value: Option<&str>) -> Option<String> {
    let v = value?.trim().to_ascii_lowercase();
    matches!(
        v.as_str(),
        "bug" | "feature" | "billing" | "account" | "other"
    )
    .then_some(v)
}

/// The status slug a write should store, validated against the owner's shared
/// `task_statuses` set. Mirrors `tasks::handler::resolve_status`: an unknown slug
/// is a 400 rather than a silent reset, and omitting `status` defaults to the
/// first status in board order.
async fn resolve_status(
    pool: &PgPool,
    owner: StatusOwner,
    value: Option<&str>,
) -> Result<String, AppError> {
    let available = statuses::load(pool, owner).await?;
    let Some(requested) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return available
            .first()
            .map(|s| s.slug.clone())
            .ok_or_else(|| AppError::internal("no statuses configured for owner"));
    };
    available
        .iter()
        .find(|s| s.slug == requested)
        .map(|s| s.slug.clone())
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "Unknown status '{requested}'. Configure it under Settings → Task statuses."
            ))
        })
}

const SELECT_COLS: &str = "id, ticket_number, name, description, priority, status, assigned_by, \
     assignee, assignee_id, project_id, related_to, relation_kind, created_at, updated_at";

#[get("/workspace-tickets")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_tickets(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // The owner's own board is the non-bug tickets; bug-derived tickets (mirrored
    // reports) are hidden there and instead shown to every tickets:manage caller.
    // badge_kind is the Type-column value: the reported bug's support category
    // when this is a mirrored report, else the type a user picked on the ticket.
    let rows = sqlx::query(&format!(
        "SELECT {SELECT_COLS},
                COALESCE(
                    (SELECT category FROM support_tickets st WHERE st.id = support_ticket_id),
                    badge_kind
                ) AS badge_kind
         FROM workspace_tickets
         WHERE (support_ticket_id IS NULL
                AND (($1::INTEGER IS NOT NULL AND organization_id = $1)
                  OR ($2::INTEGER IS NOT NULL AND user_id = $2)))
            OR ($3::BOOLEAN AND support_ticket_id IS NOT NULL)
         ORDER BY priority ASC, created_at ASC, id ASC"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(ticket_from_row).collect::<Vec<_>>()))
}

/// Count of tickets that are not in a terminal column, for the sidebar badge.
/// A LEFT JOIN to the owner's `task_statuses` maps each ticket's status slug to
/// its category; anything that is not `completed`/`canceled` (including a slug
/// with no matching status row) counts as open.
#[get("/workspace-tickets/open-count")]
#[instrument(target = "http", skip(req, pool))]
pub async fn count_open_tickets(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // Mirror list_tickets' scope so the badge matches the board: the owner's own
    // non-bug tickets, plus every bug-derived ticket when the caller manages them.
    // Category comes from the caller's own statuses (default slugs are shared).
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM workspace_tickets t
         LEFT JOIN task_statuses s
                ON s.slug = t.status
               AND (($1::INTEGER IS NOT NULL AND s.organization_id = $1)
                 OR ($2::INTEGER IS NOT NULL AND s.user_id = $2))
         WHERE ((t.support_ticket_id IS NULL
                 AND (($1::INTEGER IS NOT NULL AND t.organization_id = $1)
                   OR ($2::INTEGER IS NOT NULL AND t.user_id = $2)))
             OR ($3::BOOLEAN AND t.support_ticket_id IS NOT NULL))
           AND COALESCE(s.category, '') NOT IN ('completed', 'canceled')",
    )
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "count": count })))
}

/// The WHERE fragment (binds $1 org_id, $2 uid, $3 manage_bugs) that scopes a
/// caller to the same tickets `list_tickets` shows: their own non-bug tickets
/// plus every bug-derived ticket when they manage them. Kept as one string so
/// list / relate share exactly the same visibility.
const VISIBLE_SCOPE: &str = "((support_ticket_id IS NULL
        AND (($1::INTEGER IS NOT NULL AND organization_id = $1)
          OR ($2::INTEGER IS NOT NULL AND user_id = $2)))
     OR ($3::BOOLEAN AND support_ticket_id IS NOT NULL))";

/// The stories equivalent of `VISIBLE_SCOPE`: a story belongs to exactly one
/// owner and there is no bug-derived variant, so ownership is the whole rule.
/// `$3` (manage-bugs) is bound but deliberately inert — `AND FALSE` keeps the
/// placeholder typed so both targets share one four-bind query shape.
const STORY_VISIBLE_SCOPE: &str = "((($1::INTEGER IS NOT NULL AND organization_id = $1)
      OR ($2::INTEGER IS NOT NULL AND user_id = $2))
     OR ($3::BOOLEAN AND FALSE))";

/// The two boards that run the AI-fix pipeline. Both carry an identical set of
/// `ai_fix_*` columns, so every step below (dispatch → CI callback → commit →
/// push → PR) is written against this rather than against one table.
#[derive(Clone, Copy)]
pub struct AiFixTarget {
    /// Table holding the `ai_fix_*` columns.
    pub table: &'static str,
    /// WHERE fragment binding `$1` org_id, `$2` uid, `$3` manage_bugs, `$4` id.
    pub scope: &'static str,
    /// `ticket` | `story`. Selects the CI workflow input, the commit subject and
    /// the `ai-fix/<kind>-<id>` branch name.
    pub kind: &'static str,
    /// Label for `AppError::NotFound`.
    pub not_found: &'static str,
    /// Lowest priority *number* eligible for an automated fix. P1 is Highest, so
    /// a larger number is a lower priority: tickets open up at P4 (Low), stories
    /// only at P5 (Lowest).
    pub min_priority: i16,
    /// Whether this table records resolutions that `recall` can mine for a
    /// worked example. Only tickets carry `resolution_summary`.
    pub has_recall: bool,
    /// `audit_log.resource_type` for rows of this table.
    pub resource_type: &'static str,
    /// `audit_log.action` when a fix is dispatched.
    pub audit_requested: &'static str,
    /// `audit_log.action` when the reviewed fix reaches an open PR.
    pub audit_pr_opened: &'static str,
}

pub const TICKET_TARGET: AiFixTarget = AiFixTarget {
    table: "workspace_tickets",
    scope: VISIBLE_SCOPE,
    kind: "ticket",
    not_found: "workspace ticket",
    min_priority: 4,
    has_recall: true,
    resource_type: "workspace_ticket",
    audit_requested: "workspace_ticket_ai_fix_requested",
    audit_pr_opened: "workspace_ticket_ai_fix_pr_opened",
};

pub const STORY_TARGET: AiFixTarget = AiFixTarget {
    table: "user_stories",
    scope: STORY_VISIBLE_SCOPE,
    kind: "story",
    not_found: "user story",
    min_priority: 5,
    has_recall: false,
    resource_type: "user_story",
    audit_requested: "user_story_ai_fix_requested",
    audit_pr_opened: "user_story_ai_fix_pr_opened",
};

/// On-demand AI pass: ask Claude to group the caller's visible tickets into
/// `duplicate` / `similar` clusters and label them (`related_to` = the group's
/// canonical = min id; `relation_kind` = how it relates). Re-runnable: it first
/// clears the caller's existing labels, then re-applies, so stale links drop.
#[post("/workspace-tickets/find-related")]
#[instrument(target = "http", skip(req, pool))]
pub async fn find_related_tickets(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // Pull the visible tickets Claude will reason over.
    let rows = sqlx::query(&format!(
        "SELECT id, name, description FROM workspace_tickets WHERE {VISIBLE_SCOPE}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .fetch_all(pool.get_ref())
    .await?;
    let tickets: Vec<(i32, String, String)> = rows
        .iter()
        .map(|r| (r.get("id"), r.get("name"), r.get("description")))
        .collect();

    let groups = crate::tickets::relate::find_groups(pool.get_ref(), &tickets).await;

    // Fresh labels each run: clear this caller's existing relation labels first.
    sqlx::query(&format!(
        "UPDATE workspace_tickets SET related_to = NULL, relation_kind = NULL WHERE {VISIBLE_SCOPE}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .execute(pool.get_ref())
    .await?;

    // Each ticket gets at most one label. Claude can return overlapping groups
    // (e.g. a duplicate pair also inside a broader similar group), so apply the
    // stronger relation first (duplicate before similar) and skip any ticket
    // already labelled — otherwise a later, weaker group would clobber it.
    let mut duplicates = 0i64;
    let mut similar = 0i64;
    let mut assigned: std::collections::HashSet<i32> = std::collections::HashSet::new();
    let ordered = groups
        .iter()
        .filter(|g| g.kind == "duplicate")
        .chain(groups.iter().filter(|g| g.kind == "similar"));
    for g in ordered {
        let fresh: Vec<i32> = g
            .ids
            .iter()
            .copied()
            .filter(|id| !assigned.contains(id))
            .collect();
        // Canonical = min id (the group's anchor); the rest point at it.
        let Some(canonical) = fresh.iter().min().copied() else {
            continue;
        };
        let members: Vec<i32> = fresh
            .iter()
            .copied()
            .filter(|id| *id != canonical)
            .collect();
        if members.is_empty() {
            continue;
        }
        for id in &fresh {
            assigned.insert(*id);
        }
        // Scope the write so a caller can never label a row outside their view.
        let affected = sqlx::query(&format!(
            "UPDATE workspace_tickets SET related_to = $4, relation_kind = $5
             WHERE id = ANY($6) AND {VISIBLE_SCOPE}"
        ))
        .bind(org_id)
        .bind(uid)
        .bind(manage_bugs)
        .bind(canonical)
        .bind(&g.kind)
        .bind(&members)
        .execute(pool.get_ref())
        .await?
        .rows_affected() as i64;
        if g.kind == "duplicate" {
            duplicates += affected;
        } else {
            similar += affected;
        }
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_tickets_related",
            resource_type: "workspace_ticket",
            resource_id: None,
            metadata: Some(serde_json::json!({
                "groups": groups.len(),
                "duplicates": duplicates,
                "similar": similar,
            })),
        },
    )
    .await;

    let groups_json: Vec<Value> = groups
        .iter()
        .map(|g| serde_json::json!({ "kind": g.kind, "ids": g.ids }))
        .collect();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "groups": groups_json,
        "duplicates": duplicates,
        "similar": similar,
    })))
}

/// `POST /workspace-tickets/{id}/ai-fix` — dispatch the fixer for a ticket.
#[post("/workspace-tickets/{id}/ai-fix")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn ai_fix_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    dispatch_ai_fix(req, pool, path.into_inner(), TICKET_TARGET).await
}

/// `POST /user-stories/{id}/ai-fix` — the same pipeline for a P5 story.
#[post("/user-stories/{id}/ai-fix")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn ai_fix_story(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    dispatch_ai_fix(req, pool, path.into_inner(), STORY_TARGET).await
}

/// Dispatch the Claude Code CI fixer for one item: recall a similar past fix (if
/// the target keeps resolutions) to pass as a worked example, then trigger the
/// GitHub Actions workflow which checks out the repo, has Claude implement +
/// verify the fix, and posts the diff back. Requires `tickets:manage` (it
/// eventually opens PRs on the repo) plus `GITHUB_TOKEN` + `GITHUB_REPO`. The fix
/// runs entirely in CI — this only kicks it off.
async fn dispatch_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    target: AiFixTarget,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;
    if !manage_bugs {
        return Err(AppError::Forbidden);
    }
    let (table, scope) = (target.table, target.scope);

    // The target row, scoped to the caller's view.
    let row = sqlx::query(&format!(
        "SELECT name, description, priority FROM {table} WHERE id = $4 AND {scope}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound(target.not_found))?;
    let name: String = row.get("name");
    let description: String = row.get("description");
    let priority: i16 = row.get("priority");

    // The AI fixer is limited to the low-stakes end of the scale. P1 is Highest,
    // so eligibility is a *floor* on the number: tickets from P4 (Low) down,
    // stories only at P5 (Lowest). The UI hides the button above that; this is
    // the authoritative gate.
    if priority < target.min_priority {
        return Err(AppError::bad_request(format!(
            "AI fix is available only for P{}+ {}s",
            target.min_priority, target.kind
        )));
    }

    // Recall a resolved ticket with a stored fix that is the same kind of issue,
    // to hand the fixer as a worked example (cold-start: none until fixes accrue).
    // Only tickets record resolutions, so a story dispatches without an example.
    let mut matched: Option<i32> = None;
    let mut past_summary = String::new();
    let mut past_commit = String::new();
    if target.has_recall {
        let resolved = sqlx::query(&format!(
            "SELECT id, name, description, resolution_summary FROM {table}
             WHERE resolution_summary IS NOT NULL AND id <> $4 AND {scope}"
        ))
        .bind(org_id)
        .bind(uid)
        .bind(manage_bugs)
        .bind(id)
        .fetch_all(pool.get_ref())
        .await?;
        let candidates: Vec<crate::tickets::recall::ResolvedTicket> = resolved
            .iter()
            .map(|r| crate::tickets::recall::ResolvedTicket {
                id: r.get("id"),
                name: r.get("name"),
                description: r.get("description"),
                summary: r
                    .try_get("resolution_summary")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            })
            .collect();
        matched = crate::tickets::recall::find_similar_fix(
            pool.get_ref(),
            (id, &name, &description),
            &candidates,
        )
        .await;
        if let Some(mid) = matched {
            let m = sqlx::query(&format!(
                "SELECT resolution_summary, resolution_commit FROM {table} WHERE id = $1"
            ))
            .bind(mid)
            .fetch_one(pool.get_ref())
            .await?;
            past_summary = m
                .try_get::<Option<String>, _>("resolution_summary")
                .ok()
                .flatten()
                .unwrap_or_default();
            past_commit = m
                .try_get::<Option<String>, _>("resolution_commit")
                .ok()
                .flatten()
                .unwrap_or_default();
        }
    }

    // Kick off the CI fixer workflow via the GitHub API.
    let Some(gh_token) = crate::github_proxy::effective_github_token(&req, pool.get_ref()).await
    else {
        return Err(AppError::bad_request(
            "GitHub is not configured (GITHUB_TOKEN missing)",
        ));
    };
    let Some((gh_owner, gh_repo)) = crate::config::github_repo() else {
        return Err(AppError::bad_request(
            "Set GITHUB_REPO (owner/repo) to enable AI fix",
        ));
    };
    let api_base = crate::external::github_api_base();
    let url = format!(
        "{api_base}/repos/{gh_owner}/{gh_repo}/actions/workflows/ai-fix-ticket.yml/dispatches"
    );
    // `target_kind` tells the workflow which board to post the diff back to; it
    // defaults to "ticket" there so an older workflow file still works.
    let body = serde_json::json!({
        "ref": "main",
        "inputs": {
            "ticket_number": id.to_string(),
            "ticket_title": name,
            "ticket_description": description,
            "past_fix_summary": past_summary,
            "past_fix_commit": past_commit,
            "target_kind": target.kind,
        }
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .header("Authorization", format!("Bearer {gh_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| AppError::internal("failed to reach GitHub"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        warn!(target: "http", ticket_id = id, %code, "AI-fix workflow dispatch failed");
        return Err(AppError::bad_request(format!(
            "GitHub workflow dispatch failed ({code}); is ai-fix-ticket.yml on the default branch?"
        )));
    }

    // Mark the row "running" and clear any prior review state, so the editor
    // shows a pending state until CI posts the diff back (POST .../ai-fix-diff).
    sqlx::query(&format!(
        "UPDATE {table}
            SET ai_fix_status = 'running', ai_fix_diff = NULL, ai_fix_files = NULL,
                ai_fix_base_sha = NULL, ai_fix_commit_sha = NULL, ai_fix_branch = NULL,
                ai_fix_pr_url = NULL, updated_at = NOW()
          WHERE id = $1"
    ))
    .bind(id)
    .execute(pool.get_ref())
    .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: target.audit_requested,
            resource_type: target.resource_type,
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "reused_fix_from": matched })),
        },
    )
    .await;

    Ok(HttpResponse::Ok()
        .json(serde_json::json!({ "dispatched": true, "reused_fix_from": matched })))
}

#[derive(serde::Deserialize)]
pub struct ResolutionInput {
    pub pr_url: Option<String>,
    pub commit: Option<String>,
    pub summary: String,
}

/// Record how a ticket was resolved (the fix pointer) so a later similar ticket
/// can reuse it — called by the merge-capture workflow when an AI-fix PR lands.
/// Requires `tickets:manage`; the workflow authenticates with an API key mapped
/// to such a user. The fix code stays in Git; only the pointer + summary persist.
#[post("/workspace-tickets/{id}/resolution")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn record_resolution(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<ResolutionInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    // Service callback (API key → forced Normal mode): check DB truth, not the
    // mode-downscoped context. See `can_manage_bug_tickets_service`.
    if !can_manage_bug_tickets_service(pool.get_ref(), user_id).await {
        return Err(AppError::Forbidden);
    }
    let summary = body.summary.trim();
    if summary.is_empty() {
        return Err(AppError::BadRequest("summary is required".into()));
    }

    let updated = sqlx::query_scalar::<_, i32>(
        "UPDATE workspace_tickets
            SET resolution_pr_url = $1, resolution_commit = $2, resolution_summary = $3,
                resolved_at = NOW(), updated_at = NOW()
          WHERE id = $4
         RETURNING id",
    )
    .bind(body.pr_url.as_deref())
    .bind(body.commit.as_deref())
    .bind(summary)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?;
    if updated.is_none() {
        return Err(AppError::NotFound("workspace ticket"));
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_ticket_resolution_recorded",
            resource_type: "workspace_ticket",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "pr_url": body.pr_url, "commit": body.commit })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "recorded": true })))
}

/// GET /workspace-tickets/{id}/ai-fix — the ticket's AI-fix review state.
#[get("/workspace-tickets/{id}/ai-fix")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_ai_fix_state(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    ai_fix_state(req, pool, path.into_inner(), TICKET_TARGET).await
}

/// GET /user-stories/{id}/ai-fix — the same, for a story.
#[get("/user-stories/{id}/ai-fix")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_story_ai_fix_state(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    ai_fix_state(req, pool, path.into_inner(), STORY_TARGET).await
}

/// The item's AI-fix review state, so the editor can show a pending spinner, the
/// diff + changed files + the Commit/Push/Create-PR buttons (enabled by
/// `status`), or the opened PR link. Same gate as dispatch.
async fn ai_fix_state(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    target: AiFixTarget,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;
    if !manage_bugs {
        return Err(AppError::Forbidden);
    }
    let (table, scope) = (target.table, target.scope);

    let row = sqlx::query(&format!(
        "SELECT ai_fix_status, ai_fix_diff, ai_fix_files, ai_fix_commit_sha,
                ai_fix_branch, ai_fix_pr_url
         FROM {table} WHERE id = $4 AND {scope}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound(target.not_found))?;

    // `files` is what actually gets committed (the diff is for reading), so the
    // editor needs it to offer per-file edits before the Commit step.
    let files: Vec<AiFixFile> = row
        .try_get::<Option<serde_json::Value>, _>("ai_fix_files")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "status": row.try_get::<Option<String>, _>("ai_fix_status").ok().flatten(),
        "diff": row.try_get::<Option<String>, _>("ai_fix_diff").ok().flatten(),
        "files": files,
        "commit_sha": row.try_get::<Option<String>, _>("ai_fix_commit_sha").ok().flatten(),
        "branch": row.try_get::<Option<String>, _>("ai_fix_branch").ok().flatten(),
        "pr_url": row.try_get::<Option<String>, _>("ai_fix_pr_url").ok().flatten(),
    })))
}

/// One changed file in the CI-reported fix. `content` is base64 (so any bytes /
/// newlines survive JSON); `deleted` marks a removal (content ignored).
#[derive(serde::Deserialize, serde::Serialize)]
pub struct AiFixFile {
    pub path: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(serde::Deserialize)]
pub struct AiFixDiffInput {
    /// 'ready' (diff + base_sha + files present), 'no_change' (agent produced
    /// nothing), or 'error' (the CI run failed before it could produce a fix).
    pub status: String,
    pub diff: Option<String>,
    /// The `main` commit the change is based on (parent of the commit to create).
    pub base_sha: Option<String>,
    #[serde(default)]
    pub files: Vec<AiFixFile>,
}

/// POST /workspace-tickets/{id}/ai-fix-diff — the CI callback for a ticket.
#[post("/workspace-tickets/{id}/ai-fix-diff")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn record_ai_fix_diff(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<AiFixDiffInput>,
) -> AppResult {
    record_ai_fix(req, pool, path.into_inner(), body, TICKET_TARGET).await
}

/// POST /user-stories/{id}/ai-fix-diff — the CI callback for a story.
#[post("/user-stories/{id}/ai-fix-diff")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn record_story_ai_fix_diff(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<AiFixDiffInput>,
) -> AppResult {
    record_ai_fix(req, pool, path.into_inner(), body, STORY_TARGET).await
}

/// The CI callback. The fixer makes + verifies the change and posts the diff (for
/// review) plus the changed files + base SHA (to build the commit later). It does
/// NOT touch Git — the editor's Commit/Push/Create-PR buttons do. Authenticated
/// by an API key mapped to a tickets:manage user, exactly like `record_resolution`.
async fn record_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    body: web::Json<AiFixDiffInput>,
    target: AiFixTarget,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    if !can_manage_bug_tickets_service(pool.get_ref(), user_id).await {
        return Err(AppError::Forbidden);
    }
    let table = target.table;
    let status = match body.status.trim() {
        s @ ("ready" | "no_change" | "error") => s.to_string(),
        _ => return Err(AppError::BadRequest("invalid status".into())),
    };
    let body = body.into_inner();
    // A 'ready' report must carry the diff, base SHA, and the changed files.
    let (diff, base_sha, files_json) = if status == "ready" {
        let diff = body.diff.filter(|d| !d.is_empty());
        let base = body.base_sha.filter(|s| !s.trim().is_empty());
        if diff.is_none() || base.is_none() || body.files.is_empty() {
            return Err(AppError::BadRequest(
                "ready requires diff, base_sha and files".into(),
            ));
        }
        let files = serde_json::to_value(&body.files)
            .map_err(|_| AppError::internal("could not serialize files"))?;
        (diff, base, Some(files))
    } else {
        (None, None, None)
    };

    let updated = sqlx::query_scalar::<_, i32>(&format!(
        "UPDATE {table}
            SET ai_fix_status = $1, ai_fix_diff = $2, ai_fix_base_sha = $3, ai_fix_files = $4,
                ai_fix_commit_sha = NULL, ai_fix_branch = NULL, ai_fix_pr_url = NULL,
                updated_at = NOW()
          WHERE id = $5
         RETURNING id"
    ))
    .bind(&status)
    .bind(diff)
    .bind(base_sha)
    .bind(files_json)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?;
    if updated.is_none() {
        return Err(AppError::NotFound(target.not_found));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "recorded": true })))
}

/// Resolve the GitHub REST context (token, owner, repo, api base) for an AI-fix
/// Git operation, or a 400 explaining what is missing.
async fn gh_context(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<(String, String, String, String), AppError> {
    let token = crate::github_proxy::effective_github_token(req, pool)
        .await
        .ok_or_else(|| AppError::bad_request("GitHub is not configured (GITHUB_TOKEN missing)"))?;
    let (owner, repo) = crate::config::github_repo()
        .ok_or_else(|| AppError::bad_request("Set GITHUB_REPO (owner/repo) to enable AI fix"))?;
    Ok((token, owner, repo, crate::external::github_api_base()))
}

/// One GitHub REST call (optional JSON body) returning the parsed JSON response,
/// with a uniform error. `ok_conflict` lets the caller treat 422 (already exists)
/// as success — used when creating a ref a retry may already have made.
async fn gh_call(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<serde_json::Value>,
    ok_conflict: bool,
) -> Result<serde_json::Value, AppError> {
    let mut rb = reqwest::Client::new()
        .request(method, url)
        .timeout(std::time::Duration::from_secs(20))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .header("Authorization", format!("Bearer {token}"));
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let resp = rb
        .send()
        .await
        .map_err(|_| AppError::internal("failed to reach GitHub"))?;
    let code = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !code.is_success() {
        if ok_conflict && code == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
            return Ok(serde_json::Value::Null);
        }
        warn!(target: "http", %code, url, "GitHub API call failed: {text}");
        return Err(AppError::bad_request(format!(
            "GitHub API call failed ({code})"
        )));
    }
    if text.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| AppError::internal("invalid GitHub response"))
}

/// Load a ticket's AI-fix row for a manage-scoped mutation, or the appropriate
/// error. Returns `(user_id, row)` so each step reads the columns it needs.
async fn ai_fix_row(
    req: &HttpRequest,
    pool: &PgPool,
    id: i32,
    target: AiFixTarget,
) -> Result<(i32, sqlx::postgres::PgRow), AppError> {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool, user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(req, pool, user_id).await;
    if !manage_bugs {
        return Err(AppError::Forbidden);
    }
    let (table, scope) = (target.table, target.scope);
    let row = sqlx::query(&format!(
        "SELECT name, ai_fix_status, ai_fix_diff, ai_fix_files, ai_fix_base_sha,
                ai_fix_commit_sha, ai_fix_branch, ai_fix_pr_url
         FROM {table} WHERE id = $4 AND {scope}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound(target.not_found))?;
    Ok((user_id, row))
}

/// Replacement contents for the reviewed fix, sent by the editor's "Save edits"
/// action before Commit. Same shape as the CI callback's `files`.
#[derive(serde::Deserialize)]
pub struct AiFixEditInput {
    pub files: Vec<AiFixFile>,
    /// Regenerated unified diff to display. Optional — omitted leaves the
    /// CI-reported diff in place.
    pub diff: Option<String>,
}

/// POST /workspace-tickets/{id}/ai-fix-edit — save developer edits to a ticket fix.
#[post("/workspace-tickets/{id}/ai-fix-edit")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn edit_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<AiFixEditInput>,
) -> AppResult {
    save_ai_fix_edits(req, pool, path.into_inner(), body, TICKET_TARGET).await
}

/// POST /user-stories/{id}/ai-fix-edit — save developer edits to a story fix.
#[post("/user-stories/{id}/ai-fix-edit")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn edit_story_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<AiFixEditInput>,
) -> AppResult {
    save_ai_fix_edits(req, pool, path.into_inner(), body, STORY_TARGET).await
}

/// Overwrite the reviewed fix's file contents with the developer's edits, so the
/// Commit step builds *their* version rather than Claude's. Only valid while the
/// fix is still under review — once a commit object exists, its content is
/// already on GitHub and editing here would silently diverge from it.
async fn save_ai_fix_edits(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    body: web::Json<AiFixEditInput>,
    target: AiFixTarget,
) -> AppResult {
    let (_user, row) = ai_fix_row(&req, pool.get_ref(), id, target).await?;
    let status: Option<String> = row.try_get("ai_fix_status").ok().flatten();
    if status.as_deref() != Some("ready") {
        return Err(AppError::bad_request(
            "Only a fix that is still awaiting review can be edited",
        ));
    }
    let body = body.into_inner();
    if body.files.is_empty() {
        return Err(AppError::bad_request("A fix must change at least one file"));
    }
    // Base64 is how file bytes survive JSON; reject anything that would later
    // blow up at blob-create time, when the error is far harder to attribute.
    for f in &body.files {
        if f.path.trim().is_empty() {
            return Err(AppError::bad_request("A changed file needs a path"));
        }
        use base64::Engine as _;
        if !f.deleted
            && base64::engine::general_purpose::STANDARD
                .decode(f.content.as_bytes())
                .is_err()
        {
            return Err(AppError::bad_request(format!(
                "Contents for {} are not valid base64",
                f.path
            )));
        }
    }
    let files_json = serde_json::to_value(&body.files)
        .map_err(|_| AppError::internal("could not serialize files"))?;
    let table = target.table;
    sqlx::query(&format!(
        "UPDATE {table} SET ai_fix_files = $1,
                ai_fix_diff = COALESCE($2, ai_fix_diff), updated_at = NOW()
          WHERE id = $3"
    ))
    .bind(files_json)
    .bind(body.diff)
    .bind(id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "saved": true })))
}

/// POST /workspace-tickets/{id}/ai-fix-commit — step 1 of 3. Builds a Git commit
/// object on GitHub from the CI-reported files + base SHA (blobs → tree → commit),
/// without pointing a branch at it yet. Idempotent: returns the existing commit.
#[post("/workspace-tickets/{id}/ai-fix-commit")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn commit_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    commit_ai_fix_for(req, pool, path.into_inner(), TICKET_TARGET).await
}

/// POST /user-stories/{id}/ai-fix-commit — step 1 of 3 for a story.
#[post("/user-stories/{id}/ai-fix-commit")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn commit_story_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    commit_ai_fix_for(req, pool, path.into_inner(), STORY_TARGET).await
}

async fn commit_ai_fix_for(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    target: AiFixTarget,
) -> AppResult {
    let (_user, row) = ai_fix_row(&req, pool.get_ref(), id, target).await?;

    if let Some(sha) = row
        .try_get::<Option<String>, _>("ai_fix_commit_sha")
        .ok()
        .flatten()
    {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "commit_sha": sha })));
    }
    let status: Option<String> = row.try_get("ai_fix_status").ok().flatten();
    if status.as_deref() != Some("ready") {
        return Err(AppError::bad_request("No reviewed fix is ready to commit"));
    }
    let Some(base_sha) = row
        .try_get::<Option<String>, _>("ai_fix_base_sha")
        .ok()
        .flatten()
    else {
        return Err(AppError::bad_request(
            "No base commit recorded for this fix",
        ));
    };
    let files_val: Option<serde_json::Value> = row.try_get("ai_fix_files").ok().flatten();
    let files: Vec<AiFixFile> = files_val
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if files.is_empty() {
        return Err(AppError::bad_request(
            "No changed files recorded for this fix",
        ));
    }
    let name: String = row.get("name");

    let (token, gh_owner, gh_repo, api_base) = gh_context(&req, pool.get_ref()).await?;
    let repo = format!("{api_base}/repos/{gh_owner}/{gh_repo}");

    // Base tree of the parent commit, so unchanged files are inherited.
    let base_commit = gh_call(
        reqwest::Method::GET,
        &format!("{repo}/git/commits/{base_sha}"),
        &token,
        None,
        false,
    )
    .await?;
    let base_tree = base_commit
        .get("tree")
        .and_then(|t| t.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError::internal("base commit has no tree"))?
        .to_string();

    // One tree entry per changed file: a fresh blob for a write, a null sha for a
    // delete (GitHub removes the path from the resulting tree).
    let mut tree_entries: Vec<serde_json::Value> = Vec::with_capacity(files.len());
    for f in &files {
        if f.deleted {
            tree_entries.push(serde_json::json!({
                "path": f.path, "mode": "100644", "type": "blob", "sha": serde_json::Value::Null,
            }));
            continue;
        }
        let blob = gh_call(
            reqwest::Method::POST,
            &format!("{repo}/git/blobs"),
            &token,
            Some(serde_json::json!({ "content": f.content, "encoding": "base64" })),
            false,
        )
        .await?;
        let blob_sha = blob
            .get("sha")
            .and_then(|s| s.as_str())
            .ok_or_else(|| AppError::internal("blob create returned no sha"))?;
        tree_entries.push(serde_json::json!({
            "path": f.path, "mode": "100644", "type": "blob", "sha": blob_sha,
        }));
    }

    let tree = gh_call(
        reqwest::Method::POST,
        &format!("{repo}/git/trees"),
        &token,
        Some(serde_json::json!({ "base_tree": base_tree, "tree": tree_entries })),
        false,
    )
    .await?;
    let tree_sha = tree
        .get("sha")
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError::internal("tree create returned no sha"))?;

    let commit = gh_call(
        reqwest::Method::POST,
        &format!("{repo}/git/commits"),
        &token,
        Some(serde_json::json!({
            "message": format!("fix({}): #{id} {name}", target.kind),
            "tree": tree_sha,
            "parents": [base_sha],
        })),
        false,
    )
    .await?;
    let commit_sha = commit
        .get("sha")
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError::internal("commit create returned no sha"))?
        .to_string();

    let table = target.table;
    sqlx::query(&format!(
        "UPDATE {table} SET ai_fix_commit_sha = $1, ai_fix_status = 'committed',
                updated_at = NOW() WHERE id = $2"
    ))
    .bind(&commit_sha)
    .bind(id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "commit_sha": commit_sha })))
}

/// POST /workspace-tickets/{id}/ai-fix-push — step 2 of 3. Creates the branch ref
/// `ai-fix/ticket-<id>-<sha7>` pointing at the committed SHA (this is the "push").
#[post("/workspace-tickets/{id}/ai-fix-push")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn push_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    push_ai_fix_for(req, pool, path.into_inner(), TICKET_TARGET).await
}

/// POST /user-stories/{id}/ai-fix-push — step 2 of 3 for a story.
#[post("/user-stories/{id}/ai-fix-push")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn push_story_ai_fix(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    push_ai_fix_for(req, pool, path.into_inner(), STORY_TARGET).await
}

async fn push_ai_fix_for(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    target: AiFixTarget,
) -> AppResult {
    let (_user, row) = ai_fix_row(&req, pool.get_ref(), id, target).await?;

    if let Some(branch) = row
        .try_get::<Option<String>, _>("ai_fix_branch")
        .ok()
        .flatten()
    {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "branch": branch })));
    }
    let Some(commit_sha) = row
        .try_get::<Option<String>, _>("ai_fix_commit_sha")
        .ok()
        .flatten()
    else {
        return Err(AppError::bad_request("Commit the fix before pushing"));
    };
    let branch = format!(
        "ai-fix/{}-{id}-{}",
        target.kind,
        &commit_sha[..commit_sha.len().min(7)]
    );

    let (token, gh_owner, gh_repo, api_base) = gh_context(&req, pool.get_ref()).await?;
    gh_call(
        reqwest::Method::POST,
        &format!("{api_base}/repos/{gh_owner}/{gh_repo}/git/refs"),
        &token,
        Some(serde_json::json!({ "ref": format!("refs/heads/{branch}"), "sha": commit_sha })),
        true, // a retry may already have created the ref → treat 422 as success
    )
    .await?;

    let table = target.table;
    sqlx::query(&format!(
        "UPDATE {table} SET ai_fix_branch = $1, ai_fix_status = 'pushed',
                updated_at = NOW() WHERE id = $2"
    ))
    .bind(&branch)
    .bind(id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "branch": branch })))
}

/// POST /workspace-tickets/{id}/ai-fix-open-pr — step 3 of 3. Opens the PR from
/// the pushed branch to `main` and records the URL. Idempotent.
#[post("/workspace-tickets/{id}/ai-fix-open-pr")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn open_ai_fix_pr(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    open_ai_fix_pr_for(req, pool, path.into_inner(), TICKET_TARGET).await
}

/// POST /user-stories/{id}/ai-fix-open-pr — step 3 of 3 for a story.
#[post("/user-stories/{id}/ai-fix-open-pr")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn open_story_ai_fix_pr(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    open_ai_fix_pr_for(req, pool, path.into_inner(), STORY_TARGET).await
}

async fn open_ai_fix_pr_for(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    id: i32,
    target: AiFixTarget,
) -> AppResult {
    let (user_id, row) = ai_fix_row(&req, pool.get_ref(), id, target).await?;

    if let Some(existing) = row
        .try_get::<Option<String>, _>("ai_fix_pr_url")
        .ok()
        .flatten()
    {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "pr_url": existing })));
    }
    let Some(branch) = row
        .try_get::<Option<String>, _>("ai_fix_branch")
        .ok()
        .flatten()
    else {
        return Err(AppError::bad_request(
            "Push the fix branch before opening a PR",
        ));
    };
    let name: String = row.get("name");

    let (token, gh_owner, gh_repo, api_base) = gh_context(&req, pool.get_ref()).await?;
    let pr = gh_call(
        reqwest::Method::POST,
        &format!("{api_base}/repos/{gh_owner}/{gh_repo}/pulls"),
        &token,
        Some(serde_json::json!({
            "title": format!("fix({}): #{id} {name}", target.kind),
            "head": branch,
            "base": "main",
            "body": format!(
                "Automated fix for Workspace {} #{id}, reviewed in-app before opening.\n\n🤖 Generated by the AI-fix pipeline (Claude Code). CI must pass before merge.",
                target.kind
            ),
        })),
        false,
    )
    .await?;
    let pr_url = pr
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let table = target.table;
    sqlx::query(&format!(
        "UPDATE {table} SET ai_fix_pr_url = $1, ai_fix_status = 'pr_opened',
                updated_at = NOW() WHERE id = $2"
    ))
    .bind(&pr_url)
    .bind(id)
    .execute(pool.get_ref())
    .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: target.audit_pr_opened,
            resource_type: target.resource_type,
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "pr_url": pr_url, "branch": branch })),
        },
    )
    .await;

    // Email the actor that the PR is open. GitHub never notifies you about a PR
    // your own token opened (the fixer authors it as the token's account), so
    // without this the owner gets no "new PR" mail at all. Best-effort — a mail
    // failure must not fail the PR that already succeeded on GitHub.
    if let Ok(Some(urow)) = sqlx::query("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
        let recipient: String = urow.get("email");
        let subject = format!("AI fix PR opened — ticket #{id}: {name}");
        let body = format!(
            "The AI-fix pipeline opened a pull request for Workspace ticket #{id} ({name}).\n\n\
             Review and merge it here:\n{pr_url}\n\n\
             Branch: {branch}\n\nCI must pass before merge.\n— Wayve AI fix"
        );
        if let Err(e) = crate::email::sender::send_mail(&recipient, &subject, &body).await {
            warn!(target: "worker", error = ?e, ticket_id = id, "ai-fix PR email notification failed");
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "pr_url": pr_url })))
}

#[derive(serde::Deserialize)]
pub struct PrNotifyInput {
    number: i64,
    title: String,
    url: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    branch: String,
}

/// POST /pr-notify — email the platform mailbox that a pull request was opened.
/// Called by the `pr-notify` CI workflow for every PR (it excludes `ai-fix/*`
/// branches, which `open_ai_fix_pr` already emails), authenticated with an
/// internal API key. GitHub never emails you about PRs your own token opened, so
/// this is what actually delivers the "new PR" notification. Gated with the
/// un-downscoped platform check because API keys are forced to Normal mode.
#[post("/pr-notify")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn pr_notify(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<PrNotifyInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    if !can_manage_bug_tickets_service(pool.get_ref(), user_id).await {
        return Err(AppError::Forbidden);
    }
    // The platform SMTP `from` is the owner's own mailbox — send the notice there.
    let smtp = crate::config::smtp().map_err(AppError::internal)?;
    let author = if body.author.is_empty() {
        "unknown"
    } else {
        &body.author
    };
    let subject = format!("New PR #{}: {}", body.number, body.title);
    let text = format!(
        "A new pull request was opened on the repository.\n\n\
         #{} {}\nBy: {}\nBranch: {}\n\n{}\n",
        body.number, body.title, author, body.branch, body.url
    );
    if let Err(e) = crate::email::sender::send_mail(&smtp.from, &subject, &text).await {
        warn!(target: "worker", error = ?e, pr = body.number, "pr-notify email failed");
        return Ok(HttpResponse::BadGateway().json(serde_json::json!({ "sent": false })));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "sent": true })))
}

#[post("/workspace-tickets")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Ticket name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = resolve_status(pool.get_ref(), owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();
    let badge_kind = normalize_badge_kind(data.badge_kind.as_deref());

    // ticket_number is the next per-owner sequence value, computed inline off the
    // same owner binds so one statement assigns it.
    let row = sqlx::query(&format!(
        "INSERT INTO workspace_tickets
             (organization_id, user_id, name, description, priority, status,
              assigned_by, assignee, assignee_id, project_id, badge_kind, ticket_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 COALESCE((SELECT MAX(ticket_number) FROM workspace_tickets
                            WHERE ($1::INTEGER IS NOT NULL AND organization_id = $1)
                               OR ($2::INTEGER IS NOT NULL AND user_id = $2)), 0) + 1)
         RETURNING {SELECT_COLS}, badge_kind"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(data.assignee_id)
    .bind(data.project_id)
    .bind(badge_kind.as_deref())
    .fetch_one(pool.get_ref())
    .await?;

    let ticket = ticket_from_row(row);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_ticket_created",
            resource_type: "workspace_ticket",
            resource_id: Some(ticket.id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "status": status,
                "priority": priority,
                "assignee": assignee,
            })),
        },
    )
    .await;

    // AI triage in the background: refine the priority from the title/description
    // without blocking the response. Best-effort — skips silently if no AI config.
    crate::tickets::triage::spawn(
        pool.get_ref().clone(),
        ticket.id,
        name.to_string(),
        description.to_string(),
    );

    Ok(HttpResponse::Ok().json(ticket))
}

#[put("/workspace-tickets/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Ticket name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = resolve_status(pool.get_ref(), owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();
    let badge_kind = normalize_badge_kind(data.badge_kind.as_deref());
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // The owner-scoped UPDATE 404s on a row outside this owner's scope, so an id
    // belonging to another org/user never leaks. Bug-derived tickets are owned by
    // the reporter, so tickets:manage callers reach them via the extra clause.
    // The returned badge_kind still lets the support category win, matching list.
    let row = sqlx::query(&format!(
        "UPDATE workspace_tickets
            SET name = $1, description = $2, priority = $3, status = $4,
                assigned_by = $5, assignee = $6, assignee_id = $7, project_id = $8,
                badge_kind = $13, updated_at = NOW()
          WHERE id = $9
            AND ((($10::INTEGER IS NOT NULL AND organization_id = $10)
               OR ($11::INTEGER IS NOT NULL AND user_id = $11))
              OR ($12::BOOLEAN AND support_ticket_id IS NOT NULL))
         RETURNING {SELECT_COLS},
                   COALESCE(
                       (SELECT category FROM support_tickets st WHERE st.id = support_ticket_id),
                       badge_kind
                   ) AS badge_kind"
    ))
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(data.assignee_id)
    .bind(data.project_id)
    .bind(id)
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(badge_kind.as_deref())
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("workspace ticket"))?;

    let ticket = ticket_from_row(row);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_ticket_updated",
            resource_type: "workspace_ticket",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "status": status,
                "priority": priority,
                "assignee": assignee,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(ticket))
}

#[delete("/workspace-tickets/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    // Deliberately owner-scoped only: bug-derived tickets are mirrors of reports
    // and cannot be deleted from the board (the startup backfill would recreate
    // them anyway). Managers resolve them via a status change instead; deleting
    // the report itself is a support-flow action.
    let removed: Option<String> = sqlx::query_scalar(
        "DELETE FROM workspace_tickets
          WHERE id = $1
            AND (($2::INTEGER IS NOT NULL AND organization_id = $2)
              OR ($3::INTEGER IS NOT NULL AND user_id = $3))
            AND support_ticket_id IS NULL
         RETURNING name",
    )
    .bind(id)
    .bind(org_id)
    .bind(uid)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(ticket_name) = removed else {
        return Err(AppError::NotFound("workspace ticket"));
    };

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_ticket_deleted",
            resource_type: "workspace_ticket",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "summary": ticket_name })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
