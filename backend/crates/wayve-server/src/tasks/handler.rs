use crate::models::task::{Task, TaskInput};
use crate::prelude::*;
use crate::tasks::statuses;
use crate::webhooks::{Event, emit, handler::owner_for_user};
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Scope, resolve_role_context};

fn task_from_row(row: sqlx::postgres::PgRow) -> Task {
    Task {
        id: row.get("id"),
        task_number: row.try_get("task_number").ok().flatten(),
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
        jira_issue_key: row.try_get("jira_issue_key").ok().flatten(),
        jira_base: row.try_get("jira_base").ok().flatten(),
        gitlab_issue_iid: row.try_get("gitlab_issue_iid").ok().flatten(),
        gitlab_web_url: row.try_get("gitlab_web_url").ok().flatten(),
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    let p = value.unwrap_or(3);
    p.clamp(1, 5)
}

/// Resolves the status slug a write should store, validated against the caller's
/// own configured set.
///
/// This replaced a pure function whose fallback arm was `_ => "to_do"`. That was
/// safe only while the legal set was a fixed four-value CHECK: once statuses are
/// user-defined, a silent fallback means any slug the server doesn't recognise
/// *quietly resets the task to the first backlog status* instead of failing —
/// so a stale browser tab, or a client one deploy behind, would rewrite tasks it
/// meant to leave alone. Unknown slugs are now a 400.
///
/// Omitting `status` entirely still has a sensible default (the first status in
/// board order), since creating a task without naming a status is legitimate.
async fn resolve_status(
    pool: &PgPool,
    owner: statuses::StatusOwner,
    value: Option<&str>,
) -> Result<String, AppError> {
    let available = statuses::load(pool, owner).await?;
    let Some(requested) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return available
            .first()
            .map(|s| s.slug.clone())
            .ok_or_else(|| AppError::internal("no task statuses configured for owner"));
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

#[get("/tasks")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_tasks(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(
            "SELECT id, task_number, name, description, priority, status, assigned_by, assignee,
                    assignee_id, project_id,
                    created_at, updated_at, jira_issue_key, jira_base, gitlab_issue_iid, gitlab_web_url
             FROM tasks
             WHERE user_id = $1
             ORDER BY priority DESC, created_at ASC, id ASC",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(task_from_row).collect::<Vec<_>>()))
}

/// Users the caller can assign tasks to: their whole organization, or every
/// platform staff member. Unlike the RBAC `/members` endpoints this is open to
/// any member of the scope, because assigning a task is a baseline capability
/// and must not require `members:read`, which regular members, guests, and
/// developers lack. Personal accounts have no team and get an empty list.
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
    let status_owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let status = resolve_status(pool.get_ref(), status_owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();
    let assignee_id = data.assignee_id;
    let project_id = data.project_id;

    // task_number is the next per-user sequence value, computed inline off the
    // same $1 so one statement assigns it. Imported Jira and GitLab tasks never
    // take this path and stay un-numbered.
    let row = sqlx::query(
        "INSERT INTO tasks (user_id, name, description, priority, status, assigned_by, assignee,
                            assignee_id, project_id, task_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 COALESCE((SELECT MAX(task_number) FROM tasks WHERE user_id = $1), 0) + 1)
         RETURNING id, task_number, name, description, priority, status, assigned_by, assignee,
                   assignee_id, project_id,
                   created_at, updated_at, jira_issue_key, jira_base, gitlab_issue_iid, gitlab_web_url",
    )
    .bind(user_id)
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(assignee_id)
    .bind(project_id)
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
    let status_owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let status = resolve_status(pool.get_ref(), status_owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();
    let assignee_id = data.assignee_id;
    let project_id = data.project_id;

    let old_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM tasks WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    // The owner-scoped UPDATE 404s on another user's row, so the existence of an
    // id outside this user's scope never leaks.
    let row = sqlx::query(
        "UPDATE tasks
         SET name = $1, description = $2, priority = $3, status = $4,
             assigned_by = $5, assignee = $6, assignee_id = $7, project_id = $8,
             updated_at = NOW()
         WHERE id = $9 AND user_id = $10
         RETURNING id, task_number, name, description, priority, status, assigned_by, assignee,
                   assignee_id, project_id,
                   created_at, updated_at, jira_issue_key, jira_base, gitlab_issue_iid, gitlab_web_url",
    )
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(assignee_id)
    .bind(project_id)
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("task"))?;

    let status_changed = old_status.as_deref() != Some(status.as_str());
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

    // Best-effort mirror to a linked Jira issue. Failures are swallowed so a
    // Jira outage never fails the edit.
    crate::integrations::jira::sync::push_task_if_linked(pool.get_ref(), user_id, &task).await;

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
