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
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission};

/// Whether the caller may see and manage bug-report tickets — support tickets
/// mirrored onto the board (`support_ticket_id IS NOT NULL`). These are shared
/// across all platform staff holding `tickets:manage`, so they are excluded from
/// normal per-owner boards and only surface for such callers. Non-failing: any
/// resolution error resolves to `false`.
async fn can_manage_bug_tickets(req: &HttpRequest, pool: &PgPool, user_id: i32) -> bool {
    rbac::resolve_role_context_moded(req, pool, user_id)
        .await
        .map(|ctx| ctx.has(Permission::TicketsManage))
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
     assignee, assignee_id, project_id, created_at, updated_at";

#[get("/workspace-tickets")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_tickets(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);
    let manage_bugs = can_manage_bug_tickets(&req, pool.get_ref(), user_id).await;

    // The owner's own board is the non-bug tickets; bug-derived tickets (mirrored
    // reports) are hidden there and instead shown to every tickets:manage caller.
    let rows = sqlx::query(&format!(
        "SELECT {SELECT_COLS}
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
