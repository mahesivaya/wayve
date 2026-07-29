//! Attachments for Workspace tickets. Mirrors `tasks::attachments` but a ticket
//! is org-shared, so access is by ticket **visibility** (see
//! `handler::ticket_visible_to`), not per-user ownership. Blobs are encrypted at
//! rest on disk under ./uploads, exactly like task attachments.

use super::handler::ticket_visible_to;
use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::{Error, delete, http::header};
use futures_util::StreamExt;
use sqlx::Row;
use tracing::{error, info, instrument};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};

#[derive(Serialize)]
pub struct TicketAttachment {
    pub id: i64,
    // Serialized as `task_id` so the shared frontend `TaskAttachment` type works
    // for both boards; it carries the ticket id here.
    #[serde(rename = "task_id")]
    pub ticket_id: i32,
    pub name: String,
    pub file_type: Option<String>,
    pub size: i64,
    pub created_at: Option<NaiveDateTime>,
}

fn row_to_attachment(row: sqlx::postgres::PgRow) -> TicketAttachment {
    TicketAttachment {
        id: row.get("id"),
        ticket_id: row.get("ticket_id"),
        name: row.get("name"),
        file_type: row.try_get("file_type").ok(),
        size: row.get("size"),
        created_at: row.try_get("created_at").ok(),
    }
}

// POST /api/workspace-tickets/{id}/attachments — upload one or more files to a
// ticket visible to the caller. Multipart with `files` parts.
#[post("/workspace-tickets/{id}/attachments")]
#[instrument(target = "http", skip(req, payload, pool, path))]
pub async fn upload_attachments(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> Result<HttpResponse, Error> {
    let ticket_id = path.into_inner();
    // AppError implements ResponseError, so `?` maps a not-visible ticket (404)
    // or auth failure straight into the multipart handler's actix Error.
    let user_id = ticket_visible_to(&req, pool.get_ref(), ticket_id).await?;

    let mut saved: Vec<TicketAttachment> = Vec::new();

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
        let filepath = crate::storage::stored_path(&format!("ticket_{ticket_id}_{file_id}"));

        let mut size: i64 = 0;
        let mut plaintext: Vec<u8> = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        let (file_iv, encrypted_bytes) = encrypt_binary(&plaintext)
            .map_err(|_| actix_web::error::ErrorInternalServerError("File encrypt error"))?;

        crate::storage::put(&filepath, encrypted_bytes)
            .await
            .map_err(|e| {
                error!(target: "http", path = %filepath, error = %e, "ticket attachment write failed");
                actix_web::error::ErrorInternalServerError("Write error")
            })?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        let row = sqlx::query(
            "INSERT INTO ticket_attachments (ticket_id, user_id, name, file_type, file_path, file_iv, size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, ticket_id, name, file_type, size, created_at",
        )
        .bind(ticket_id)
        .bind(user_id)
        .bind(&filename)
        .bind(&file_type)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .fetch_one(pool.get_ref())
        .await
        .map_err(|e| {
            error!(target: "http", user_id, ticket_id, error = ?e, "ticket attachment insert failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

        info!(target: "http", "Ticket attachment saved: ticket_id={ticket_id} name=\"{filename}\" size={size}");
        saved.push(row_to_attachment(row));
    }

    Ok(HttpResponse::Ok().json(saved))
}

// GET /api/workspace-tickets/{id}/attachments — list a visible ticket's files.
#[get("/workspace-tickets/{id}/attachments")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn list_attachments(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ticket_id = path.into_inner();
    ticket_visible_to(&req, pool.get_ref(), ticket_id).await?;

    let rows = sqlx::query(
        "SELECT id, ticket_id, name, file_type, size, created_at
         FROM ticket_attachments WHERE ticket_id = $1
         ORDER BY created_at ASC, id ASC",
    )
    .bind(ticket_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(row_to_attachment).collect::<Vec<_>>()))
}

// GET /api/ticket-attachments/{id}/download — stream a decrypted file if its
// ticket is visible to the caller.
#[get("/ticket-attachments/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "SELECT ticket_id, name, file_path, file_iv FROM ticket_attachments WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let ticket_id: i32 = row.get("ticket_id");
    // 404 (not 403) if the caller can't see the ticket — don't leak existence.
    if ticket_visible_to(&req, pool.get_ref(), ticket_id)
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
                Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
                    AppError::Internal(format!("ticket attachment decrypt failed: {e}"))
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
            error!(target: "http", attachment_id, error = ?e, "ticket attachment open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

// DELETE /api/ticket-attachments/{id} — remove a file if its ticket is visible.
#[delete("/ticket-attachments/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let attachment_id = path.into_inner();

    let row = sqlx::query("SELECT ticket_id, file_path FROM ticket_attachments WHERE id = $1")
        .bind(attachment_id)
        .fetch_optional(pool.get_ref())
        .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound("attachment"));
    };
    let ticket_id: i32 = row.get("ticket_id");
    ticket_visible_to(&req, pool.get_ref(), ticket_id).await?;
    let file_path: String = row.get("file_path");

    sqlx::query("DELETE FROM ticket_attachments WHERE id = $1")
        .bind(attachment_id)
        .execute(pool.get_ref())
        .await?;

    // Best-effort blob cleanup: the row is already gone.
    if let Err(e) = crate::storage::delete(&file_path).await {
        error!(target: "http", attachment_id, error = %e, "ticket attachment blob remove failed");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
