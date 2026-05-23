use crate::models::task::{Task, TaskInput};
use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;

fn task_from_row(row: sqlx::postgres::PgRow) -> Task {
    Task {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        priority: row.get("priority"),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    let p = value.unwrap_or(3);
    p.clamp(1, 5)
}

#[get("/tasks")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_tasks(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        "SELECT id, name, description, priority, created_at, updated_at
         FROM tasks
         WHERE user_id = $1
         ORDER BY priority DESC, created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(task_from_row).collect::<Vec<_>>()))
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

    let row = sqlx::query(
        "INSERT INTO tasks (user_id, name, description, priority)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, priority, created_at, updated_at",
    )
    .bind(user_id)
    .bind(name)
    .bind(description)
    .bind(priority)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(task_from_row(row)))
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

    // Owner-scoped UPDATE — returns 404 if the row belongs to another user,
    // so we never leak the existence of an id outside this user's scope.
    let row = sqlx::query(
        "UPDATE tasks
         SET name = $1, description = $2, priority = $3, updated_at = NOW()
         WHERE id = $4 AND user_id = $5
         RETURNING id, name, description, priority, created_at, updated_at",
    )
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("task"))?;

    Ok(HttpResponse::Ok().json(task_from_row(row)))
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

    let result = sqlx::query("DELETE FROM tasks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("task"));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
