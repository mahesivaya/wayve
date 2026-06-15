use crate::models::task::{Task, TaskInput};
use crate::prelude::*;
use crate::webhooks::{Event, emit, handler::owner_for_user};
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Scope, resolve_role_context};

fn task_from_row(row: sqlx::postgres::PgRow) -> Task {
    Task {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        priority: row.get("priority"),
        status: row.get("status"),
        assigned_by: row.try_get("assigned_by").unwrap_or_default(),
        assignee: row.try_get("assignee").unwrap_or_default(),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    let p = value.unwrap_or(3);
    p.clamp(1, 5)
}

fn normalize_status(value: Option<&str>) -> &'static str {
    match value.map(|s| s.trim()) {
        Some("done") => "done",
        Some("in_review") => "in_review",
        Some("in_progress") => "in_progress",
        _ => "to_do",
    }
}

#[get("/tasks")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_tasks(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        "SELECT id, name, description, priority, status, assigned_by, assignee, created_at, updated_at
         FROM tasks
         WHERE user_id = $1
         ORDER BY priority DESC, created_at ASC, id ASC",
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(task_from_row).collect::<Vec<_>>()))
}

/// Users the caller can assign tasks to: everyone in their organization (org
/// scope) or every platform staff member (platform scope). Unlike the RBAC
/// `/members` endpoints this is open to *any* member of the scope — assigning a
/// task is a baseline capability, so it must not require `members:read` (which
/// regular members/guests/developers lack). Personal accounts have no team and
/// get an empty list. Returns `[{ user_id, email, username }]`, email-sorted.
#[get("/tasks/assignable-users")]
#[instrument(target = "http", skip(req, pool))]
pub async fn assignable_users(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let ctx = resolve_role_context(pool.get_ref(), user_id).await?;

    let rows = match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::Ok().json(Vec::<serde_json::Value>::new()));
            };
            sqlx::query(
                "SELECT id AS user_id, email, username
                 FROM users WHERE organization_id = $1 ORDER BY email",
            )
            .bind(org_id)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Platform => {
            sqlx::query(
                "SELECT u.id AS user_id, u.email, u.username
                 FROM platform_members pm
                 JOIN users u ON u.id = pm.user_id
                 ORDER BY u.email",
            )
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Personal => Vec::new(),
    };

    let people = rows
        .iter()
        .map(|row| {
            let user_id: i32 = row.get("user_id");
            let email: String = row.get("email");
            let username: Option<String> = row.try_get("username").ok().flatten();
            serde_json::json!({ "user_id": user_id, "email": email, "username": username })
        })
        .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(people))
}

#[post("/tasks")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_task(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Task name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = normalize_status(data.status.as_deref());
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();

    let row = sqlx::query(
        "INSERT INTO tasks (user_id, name, description, priority, status, assigned_by, assignee)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, priority, status, assigned_by, assignee, created_at, updated_at",
    )
    .bind(user_id)
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(status)
    .bind(assigned_by)
    .bind(assignee)
    .fetch_one(pool.get_ref())
    .await?;

    let task = task_from_row(row);

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "task_created",
            resource_type: "task",
            resource_id: Some(task.id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "status": status,
                "priority": priority,
                "assigned_by": assigned_by,
                "assignee": assignee,
                "attachments": 0,
            })),
        },
    )
    .await;

    let owner = owner_for_user(pool.get_ref(), user_id).await;
    emit(
        pool.get_ref(),
        owner,
        Event::TaskCreated,
        serde_json::to_value(&task).unwrap_or_default(),
    )
    .await;

    Ok(HttpResponse::Ok().json(task))
}

#[put("/tasks/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_task(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Task name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = normalize_status(data.status.as_deref());
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();

    // Capture the prior status so we can record "every status change".
    let old_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM tasks WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    // Owner-scoped UPDATE — returns 404 if the row belongs to another user,
    // so we never leak the existence of an id outside this user's scope.
    let row = sqlx::query(
        "UPDATE tasks
         SET name = $1, description = $2, priority = $3, status = $4,
             assigned_by = $5, assignee = $6, updated_at = NOW()
         WHERE id = $7 AND user_id = $8
         RETURNING id, name, description, priority, status, assigned_by, assignee, created_at, updated_at",
    )
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("task"))?;

    let status_changed = old_status.as_deref() != Some(status);
    let attachments_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM task_attachments WHERE task_id = $1")
            .bind(id)
            .fetch_one(pool.get_ref())
            .await
            .unwrap_or(0);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: if status_changed {
                "task_status_changed"
            } else {
                "task_updated"
            },
            resource_type: "task",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "old_status": old_status,
                "new_status": status,
                "status": status,
                "priority": priority,
                "assigned_by": assigned_by,
                "assignee": assignee,
                "attachments": attachments_count,
            })),
        },
    )
    .await;

    let task = task_from_row(row);
    let owner = owner_for_user(pool.get_ref(), user_id).await;
    emit(
        pool.get_ref(),
        owner,
        Event::TaskUpdated,
        serde_json::to_value(&task).unwrap_or_default(),
    )
    .await;

    Ok(HttpResponse::Ok().json(task))
}

#[delete("/tasks/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_task(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let removed: Option<String> =
        sqlx::query_scalar("DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING name")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    let Some(task_name) = removed else {
        return Err(AppError::NotFound("task"));
    };

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "task_deleted",
            resource_type: "task",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "summary": task_name })),
        },
    )
    .await;

    let owner = owner_for_user(pool.get_ref(), user_id).await;
    emit(
        pool.get_ref(),
        owner,
        Event::TaskDeleted,
        serde_json::json!({ "id": id }),
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
