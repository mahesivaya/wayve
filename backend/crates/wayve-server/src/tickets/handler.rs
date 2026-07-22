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
        // Present only in the list query (bug-derived tickets); absent elsewhere.
        badge_kind: row.try_get("badge_kind").ok().flatten(),
        related_to: row.try_get("related_to").ok().flatten(),
        relation_kind: row.try_get("relation_kind").ok().flatten(),
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    value.unwrap_or(3).clamp(1, 5)
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
    // badge_kind carries the reported bug's support category for a card badge.
    let rows = sqlx::query(&format!(
        "SELECT {SELECT_COLS},
                (SELECT category FROM support_tickets st WHERE st.id = support_ticket_id) AS badge_kind
         FROM workspace_tickets
         WHERE (support_ticket_id IS NULL
                AND (($1::INTEGER IS NOT NULL AND organization_id = $1)
                  OR ($2::INTEGER IS NOT NULL AND user_id = $2)))
            OR ($3::BOOLEAN AND support_ticket_id IS NOT NULL)
         ORDER BY priority DESC, created_at ASC, id ASC"
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

/// Dispatch the Claude Code CI fixer for a ticket: recall a similar past fix (if
/// any) to pass as a worked example, then trigger the GitHub Actions workflow
/// which checks out the repo, has Claude implement + verify the fix, and opens a
/// PR. Requires `tickets:manage` (it opens PRs on the repo) plus `GITHUB_TOKEN` +
/// `GITHUB_REPO` configured. The fix runs entirely in CI — this only kicks it off.
#[post("/workspace-tickets/{id}/ai-fix")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn ai_fix_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;
    if !manage_bugs {
        return Err(AppError::Forbidden);
    }

    // The target ticket, scoped to the caller's view.
    let row = sqlx::query(&format!(
        "SELECT name, description FROM workspace_tickets WHERE id = $4 AND {VISIBLE_SCOPE}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(manage_bugs)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("workspace ticket"))?;
    let name: String = row.get("name");
    let description: String = row.get("description");

    // Recall a resolved ticket with a stored fix that is the same kind of issue,
    // to hand the fixer as a worked example (cold-start: none until fixes accrue).
    let resolved = sqlx::query(&format!(
        "SELECT id, name, description, resolution_summary FROM workspace_tickets
         WHERE resolution_summary IS NOT NULL AND id <> $4 AND {VISIBLE_SCOPE}"
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
    let matched = crate::tickets::recall::find_similar_fix(
        pool.get_ref(),
        (id, &name, &description),
        &candidates,
    )
    .await;
    let (past_summary, past_commit) = match matched {
        Some(mid) => {
            let m = sqlx::query(
                "SELECT resolution_summary, resolution_commit FROM workspace_tickets WHERE id = $1",
            )
            .bind(mid)
            .fetch_one(pool.get_ref())
            .await?;
            (
                m.try_get::<Option<String>, _>("resolution_summary")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                m.try_get::<Option<String>, _>("resolution_commit")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            )
        }
        None => (String::new(), String::new()),
    };

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
    let body = serde_json::json!({
        "ref": "main",
        "inputs": {
            "ticket_number": id.to_string(),
            "ticket_title": name,
            "ticket_description": description,
            "past_fix_summary": past_summary,
            "past_fix_commit": past_commit,
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

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "workspace_ticket_ai_fix_requested",
            resource_type: "workspace_ticket",
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
    if !can_manage_bug_tickets(&req, pool.get_ref(), user_id).await {
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

    // ticket_number is the next per-owner sequence value, computed inline off the
    // same owner binds so one statement assigns it.
    let row = sqlx::query(&format!(
        "INSERT INTO workspace_tickets
             (organization_id, user_id, name, description, priority, status,
              assigned_by, assignee, assignee_id, project_id, ticket_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 COALESCE((SELECT MAX(ticket_number) FROM workspace_tickets
                            WHERE ($1::INTEGER IS NOT NULL AND organization_id = $1)
                               OR ($2::INTEGER IS NOT NULL AND user_id = $2)), 0) + 1)
         RETURNING {SELECT_COLS}"
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
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // The owner-scoped UPDATE 404s on a row outside this owner's scope, so an id
    // belonging to another org/user never leaks. Bug-derived tickets are owned by
    // the reporter, so tickets:manage callers reach them via the extra clause.
    let row = sqlx::query(&format!(
        "UPDATE workspace_tickets
            SET name = $1, description = $2, priority = $3, status = $4,
                assigned_by = $5, assignee = $6, assignee_id = $7, project_id = $8,
                updated_at = NOW()
          WHERE id = $9
            AND ((($10::INTEGER IS NOT NULL AND organization_id = $10)
               OR ($11::INTEGER IS NOT NULL AND user_id = $11))
              OR ($12::BOOLEAN AND support_ticket_id IS NOT NULL))
         RETURNING {SELECT_COLS}"
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
