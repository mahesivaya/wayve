use crate::models::note::{Note, NoteInput};
use crate::prelude::*;
use crate::security::encryption::{decrypt, encrypt};
use crate::security::jwt::get_user_id_from_request;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;

fn decrypt_field(
    iv: Option<String>,
    encrypted: Option<String>,
    legacy_plaintext: Option<String>,
) -> Option<String> {
    match (iv, encrypted) {
        (Some(iv), Some(encrypted)) if !iv.is_empty() && !encrypted.is_empty() => {
            match decrypt(&iv, &encrypted) {
                Ok(value) => Some(value),
                Err(_) => Some("[decryption failed]".to_string()),
            }
        }
        _ => legacy_plaintext,
    }
}

fn note_from_row(row: sqlx::postgres::PgRow) -> Note {
    Note {
        id: row.get("id"),
        title: decrypt_field(
            row.try_get("title_iv").ok(),
            row.try_get("title_encrypted").ok(),
            row.try_get("title").ok(),
        ),
        content: decrypt_field(
            row.try_get("content_iv").ok(),
            row.try_get("content_encrypted").ok(),
            row.try_get("content").ok(),
        ),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
    }
}

#[get("/notes")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_notes(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        "SELECT id, title, content, title_encrypted, title_iv, content_encrypted, content_iv, created_at, updated_at
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

    let title = data.title.as_deref().unwrap_or("");
    let content = data.content.as_deref().unwrap_or("");
    let (title_iv, title_encrypted) = encrypt(title)
        .map_err(|e| AppError::Internal(format!("note title encrypt failed: {e}")))?;
    let (content_iv, content_encrypted) = encrypt(content)
        .map_err(|e| AppError::Internal(format!("note content encrypt failed: {e}")))?;

    let row = sqlx::query(
        "INSERT INTO notes (user_id, title, content, title_encrypted, title_iv, content_encrypted, content_iv)
         VALUES ($1, '', '', $2, $3, $4, $5)
         RETURNING id, title, content, title_encrypted, title_iv, content_encrypted, content_iv, created_at, updated_at",
    )
    .bind(user_id)
    .bind(&title_encrypted)
    .bind(&title_iv)
    .bind(&content_encrypted)
    .bind(&content_iv)
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
    let title = data.title.as_deref().unwrap_or("");
    let content = data.content.as_deref().unwrap_or("");
    let (title_iv, title_encrypted) = encrypt(title)
        .map_err(|e| AppError::Internal(format!("note title encrypt failed: {e}")))?;
    let (content_iv, content_encrypted) = encrypt(content)
        .map_err(|e| AppError::Internal(format!("note content encrypt failed: {e}")))?;

    let row = sqlx::query(
        "UPDATE notes
         SET title = '', content = '', title_encrypted = $1, title_iv = $2,
             content_encrypted = $3, content_iv = $4, updated_at = NOW()
         WHERE id = $5 AND user_id = $6
         RETURNING id, title, content, title_encrypted, title_iv, content_encrypted, content_iv, created_at, updated_at",
    )
    .bind(&title_encrypted)
    .bind(&title_iv)
    .bind(&content_encrypted)
    .bind(&content_iv)
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
