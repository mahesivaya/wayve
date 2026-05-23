use crate::models::note::{Note, NoteInput};
use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;

fn note_from_row(row: sqlx::postgres::PgRow) -> Note {
    Note {
        id: row.get("id"),
        // In E2EE mode, the 'title' and 'content' columns contain the 
        // WAYVE_SECURE_V1 envelope strings directly. We pass them to the 
        // frontend as-is for client-side decryption.
        title: row.try_get("title").ok(),
        content: row.try_get("content").ok(),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
    }
}

#[get("/notes")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_notes(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        "SELECT id, title, content, created_at, updated_at
         FROM notes
         WHERE user_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(note_from_row).collect::<Vec<_>>()))
}

#[post("/notes")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_note(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<NoteInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let title = data.title.as_deref().unwrap_or("Untitled");
    let content = data.content.as_deref().unwrap_or("");

    let row = sqlx::query(
        "INSERT INTO notes (user_id, title, content)
         VALUES ($1, $2, $3)
         RETURNING id, title, content, created_at, updated_at",
    )
    .bind(user_id)
    .bind(title)
    .bind(content)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(note_from_row(row)))
}

#[put("/notes/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_note(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<NoteInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    // Owner-scoped UPDATE — silently no-ops if the note belongs to someone
    // else, so we 404 rather than leaking that the id exists.
    let title = data.title.as_deref().unwrap_or("Untitled");
    let content = data.content.as_deref().unwrap_or("");

    let row = sqlx::query(
        "UPDATE notes
         SET title = $1, content = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4
         RETURNING id, title, content, created_at, updated_at",
    )
    .bind(title)
    .bind(content)
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("note"))?;

    Ok(HttpResponse::Ok().json(note_from_row(row)))
}

#[delete("/notes/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_note(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let result = sqlx::query("DELETE FROM notes WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("note"));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
