use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::{Error, delete, http::header};
use futures_util::StreamExt;
use sqlx::Row;
use tracing::{error, info, instrument};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};
use wayve_security::jwt::get_user_id_from_request;

#[derive(Serialize)]
pub struct TaskAttachment {
    pub id: i64,
    pub task_id: i32,
    pub name: String,
    pub file_type: Option<String>,
    pub size: i64,
    pub created_at: Option<NaiveDateTime>,
}

fn row_to_attachment(row: sqlx::postgres::PgRow) -> TaskAttachment {
    TaskAttachment {
        id: row.get("id"),
        task_id: row.get("task_id"),
        name: row.get("name"),
        file_type: row.try_get("file_type").ok(),
        size: row.get("size"),
        created_at: row.try_get("created_at").ok(),
    }
}

async fn task_belongs_to_user(pool: &PgPool, task_id: i32, user_id: i32) -> sqlx::Result<bool> {
    let owns: Option<i32> =
        sqlx::query_scalar("SELECT id FROM tasks WHERE id = $1 AND user_id = $2")
            .bind(task_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(owns.is_some())
}

#[post("/tasks/{id}/attachments")]
#[instrument(target = "http", skip(req, payload, pool, path))]
pub async fn upload_attachments(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> Result<HttpResponse, Error> {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };
    let task_id = path.into_inner();

    let owns = task_belongs_to_user(pool.get_ref(), task_id, user_id)
        .await
        .map_err(|e| {
            error!(target: "http", error = ?e, "task ownership check failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;
    if !owns {
        return Ok(HttpResponse::NotFound().finish());
    }

    let mut saved: Vec<TaskAttachment> = Vec::new();

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;
        if field.name() != "files" {
            continue;
        }

        let content_disposition = field.content_disposition();
        let raw_filename = content_disposition
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;
        let filename = raw_filename.replace(['/', '\\'], "");

        // The on-disk blob is named from a UUID, never the user's filename; the
        // original name lives in the `name` column and is what the download
        // handler serves. This avoids path injection and dodges filesystems that
        // reject characters ext4 allows, such as the dev virtiofs mount choking
        // on the colon in macOS screenshot names.
        let file_id = Uuid::new_v4().to_string();
        let filepath = crate::storage::stored_path(&format!("task_{task_id}_{file_id}"));

        let mut size: i64 = 0;
        let mut plaintext: Vec<u8> = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        let (file_iv, encrypted_bytes) = encrypt_binary(&plaintext).map_err(|e| {
            error!(target: "http", error = %e, "task attachment encrypt failed");
            actix_web::error::ErrorInternalServerError("File encrypt error")
        })?;

        crate::storage::put(&filepath, encrypted_bytes)
            .await
            .map_err(|e| {
                error!(target: "http", path = %filepath, error = %e, "task attachment write failed");
                actix_web::error::ErrorInternalServerError("Write error")
            })?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        let row = sqlx::query(
            r#"
            INSERT INTO task_attachments (task_id, user_id, name, file_type, file_path, file_iv, size)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, task_id, name, file_type, size, created_at
            "#,
        )
        .bind(task_id)
        .bind(user_id)
        .bind(&filename)
        .bind(&file_type)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .fetch_one(pool.get_ref())
        .await
        .map_err(|e| {
            error!(target: "http", user_id, task_id, error = ?e, "task attachment insert failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

        info!(
            target: "http",
            "Task attachment saved: task_id={} name=\"{}\" size={}",
            task_id, filename, size
        );
        saved.push(row_to_attachment(row));
    }

    Ok(HttpResponse::Ok().json(saved))
}

#[get("/tasks/{id}/attachments")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn list_attachments(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let task_id = path.into_inner();

    let owns = task_belongs_to_user(pool.get_ref(), task_id, user_id).await?;
    if !owns {
        return Err(AppError::NotFound("task"));
    }

    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(
            "SELECT id, task_id, name, file_type, size, created_at
             FROM task_attachments
             WHERE task_id = $1
             ORDER BY created_at ASC, id ASC",
        )
        .bind(task_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(row_to_attachment).collect::<Vec<_>>()))
}

#[get("/task-attachments/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "SELECT name, file_path, file_iv
         FROM task_attachments
         WHERE id = $1 AND user_id = $2",
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };

    let name: String = row.get("name");
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.try_get("file_iv").ok();

    match crate::storage::get(&file_path).await {
        Ok(bytes) => {
            let body = match file_iv.as_deref().filter(|v| !v.is_empty()) {
                Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
                    AppError::Internal(format!("task attachment decrypt failed: {e}"))
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
            error!(target: "http", user_id, attachment_id, error = ?e, "task attachment open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

#[delete("/task-attachments/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "DELETE FROM task_attachments WHERE id = $1 AND user_id = $2 RETURNING file_path",
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound("attachment"));
    };

    let file_path: String = row.get("file_path");
    // Best-effort blob cleanup: the row is already gone, so a stale file cannot
    // be re-fetched.
    if let Err(e) = crate::storage::delete(&file_path).await {
        error!(target: "http", user_id, attachment_id, error = %e, "task attachment blob remove failed");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
