//! Attachments for user stories. Mirrors `tickets::attachments`: a story is
//! shared by its owner (an organization's one backlog, or a personal or platform
//! account's own), so access is by story **ownership scope**, not by who
//! uploaded the file. Blobs are encrypted at rest under ./uploads, exactly like
//! task and ticket attachments.

use crate::prelude::*;
use crate::tasks::statuses::{self, StatusOwner};
use actix_multipart::Multipart;
use actix_web::{Error, delete, http::header};
use futures_util::StreamExt;
use sqlx::Row;
use tracing::{error, info, instrument};
use uuid::Uuid;
use wayve_security::jwt::get_user_id_from_request;

#[derive(Serialize)]
pub struct StoryAttachment {
    pub id: i64,
    // Serialized as `task_id` so the shared frontend `TaskAttachment` type works
    // for every board; it carries the story id here.
    #[serde(rename = "task_id")]
    pub story_id: i32,
    pub name: String,
    pub file_type: Option<String>,
    pub size: i64,
    pub created_at: Option<NaiveDateTime>,
}

fn row_to_attachment(row: sqlx::postgres::PgRow) -> StoryAttachment {
    StoryAttachment {
        id: row.get("id"),
        story_id: row.get("story_id"),
        name: row.get("name"),
        file_type: row.try_get("file_type").ok(),
        size: row.get("size"),
        created_at: row.try_get("created_at").ok(),
    }
}

/// Resolve the caller and confirm `story_id` belongs to their backlog (their
/// organization's, or their own). Returns the caller's `user_id` on success and
/// `NotFound` otherwise, so a story in another scope never leaks its existence.
async fn story_visible_to(
    req: &HttpRequest,
    pool: &PgPool,
    story_id: i32,
) -> Result<i32, AppError> {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let (org_id, uid) = match statuses::owner_for_user(pool, user_id).await? {
        StatusOwner::Organization(id) => (Some(id), None),
        StatusOwner::User(id) => (None, Some(id)),
    };
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM user_stories
          WHERE id = $1
            AND (($2::INTEGER IS NOT NULL AND organization_id = $2)
              OR ($3::INTEGER IS NOT NULL AND user_id = $3))",
    )
    .bind(story_id)
    .bind(org_id)
    .bind(uid)
    .fetch_optional(pool)
    .await?;
    found
        .map(|_| user_id)
        .ok_or(AppError::NotFound("user story"))
}

// POST /api/user-stories/{id}/attachments — upload one or more files to a story
// in the caller's backlog. Multipart with `files` parts.
#[post("/user-stories/{id}/attachments")]
#[instrument(target = "http", skip(req, payload, pool, path))]
pub async fn upload_attachments(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> Result<HttpResponse, Error> {
    let story_id = path.into_inner();
    // AppError implements ResponseError, so `?` maps a story outside the
    // caller's scope (404) or an auth failure straight into the actix Error.
    let user_id = story_visible_to(&req, pool.get_ref(), story_id).await?;

    let mut saved: Vec<StoryAttachment> = Vec::new();

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;
        if field.name() != "files" {
            continue;
        }

        let raw_filename = field
            .content_disposition()
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;
        let filename = raw_filename.replace(['/', '\\'], "");

        // On-disk blob is UUID-named, never the user's filename (path-injection
        // safe); the original name lives in the `name` column.
        let file_id = Uuid::new_v4().to_string();
        let filepath = crate::storage::stored_path(&format!("story_{story_id}_{file_id}"));

        let mut size: i64 = 0;
        let mut plaintext: Vec<u8> = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        let (file_iv, encrypted_bytes) = crate::storage::encrypt_file(plaintext)
            .await
            .map_err(|_| actix_web::error::ErrorInternalServerError("File encrypt error"))?;

        crate::storage::put(&filepath, encrypted_bytes)
            .await
            .map_err(|e| {
                error!(target: "http", path = %filepath, error = %e, "story attachment write failed");
                actix_web::error::ErrorInternalServerError("Write error")
            })?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        let row = sqlx::query(
            "INSERT INTO story_attachments (story_id, user_id, name, file_type, file_path, file_iv, size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, story_id, name, file_type, size, created_at",
        )
        .bind(story_id)
        .bind(user_id)
        .bind(&filename)
        .bind(&file_type)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .fetch_one(pool.get_ref())
        .await
        .map_err(|e| {
            error!(target: "http", user_id, story_id, error = ?e, "story attachment insert failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

        info!(target: "http", "Story attachment saved: story_id={story_id} name=\"{filename}\" size={size}");
        saved.push(row_to_attachment(row));
    }

    Ok(HttpResponse::Ok().json(saved))
}

// GET /api/user-stories/{id}/attachments — list a story's files.
#[get("/user-stories/{id}/attachments")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn list_attachments(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let story_id = path.into_inner();
    story_visible_to(&req, pool.get_ref(), story_id).await?;

    let rows = sqlx::query(
        "SELECT id, story_id, name, file_type, size, created_at
         FROM story_attachments WHERE story_id = $1
         ORDER BY created_at ASC, id ASC",
    )
    .bind(story_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(row_to_attachment).collect::<Vec<_>>()))
}

// GET /api/story-attachments/{id}/download — stream a decrypted file if its
// story is in the caller's backlog.
#[get("/story-attachments/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "SELECT story_id, name, file_path, file_iv FROM story_attachments WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let story_id: i32 = row.get("story_id");
    // 404 (not 403) if the story isn't the caller's — don't leak existence.
    if story_visible_to(&req, pool.get_ref(), story_id)
        .await
        .is_err()
    {
        return Ok(HttpResponse::NotFound().finish());
    }

    let name: String = row.get("name");
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.try_get("file_iv").ok();

    match crate::storage::get(&file_path).await {
        Ok(bytes) => {
            let body = match file_iv.as_deref().filter(|v| !v.is_empty()) {
                Some(iv) => crate::storage::decrypt_file(iv.to_owned(), bytes)
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("story attachment decrypt failed: {e}"))
                    })?,
                None => bytes,
            };
            Ok(HttpResponse::Ok()
                .append_header((header::CONTENT_TYPE, "application/octet-stream"))
                .append_header((
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", name.replace('"', "")),
                ))
                .body(body))
        }
        Err(e) => {
            error!(target: "http", attachment_id, error = ?e, "story attachment open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

// DELETE /api/story-attachments/{id} — remove a file if its story is in the
// caller's backlog.
#[delete("/story-attachments/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let attachment_id = path.into_inner();

    let row = sqlx::query("SELECT story_id, file_path FROM story_attachments WHERE id = $1")
        .bind(attachment_id)
        .fetch_optional(pool.get_ref())
        .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound("attachment"));
    };
    let story_id: i32 = row.get("story_id");
    story_visible_to(&req, pool.get_ref(), story_id).await?;
    let file_path: String = row.get("file_path");

    sqlx::query("DELETE FROM story_attachments WHERE id = $1")
        .bind(attachment_id)
        .execute(pool.get_ref())
        .await?;

    // Best-effort blob cleanup: the row is already gone.
    if let Err(e) = crate::storage::delete(&file_path).await {
        error!(target: "http", attachment_id, error = %e, "story attachment blob remove failed");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
