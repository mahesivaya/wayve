//! Chat file attachments, for both direct messages and channel messages.
//!
//! Upload stores one file under `./uploads`, always wrapped in the server
//! at-rest AES layer. With `e2e=true` the uploaded bytes are already a client
//! ciphertext, so the at-rest layer double-wraps something the server cannot
//! read; with `e2e=false` it is the only encryption. Upload is
//! conversation-agnostic: the row starts unlinked and the WS send later sets
//! exactly one of `message_id` (DM) or `channel_message_id`, since DMs and
//! channel messages are separate tables with separate id spaces.
//!
//! Download is gated to the uploader before the message is sent and, once
//! linked, to the DM's participants or a current member of the message's
//! channel.

use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::{Error, HttpResponse, get, post, web};
use futures_util::StreamExt;
use sqlx::{PgPool, Row};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{error, info, instrument};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};
use wayve_security::jwt::get_user_id_from_request;

// Reject absurdly large attachments early (matches the ~25 MB client cap).
const MAX_ATTACHMENT_BYTES: i64 = 25 * 1024 * 1024;

#[post("/chat/attachments")]
#[instrument(target = "http", skip(req, payload, pool))]
pub async fn upload_chat_attachment(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, Error> {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let upload_dir = "./uploads";
    fs::create_dir_all(upload_dir).await.map_err(|e| {
        error!(target: "http", error = ?e, "upload dir create failed");
        actix_web::error::ErrorInternalServerError("Dir error")
    })?;

    let mut e2e = true;
    let mut filename: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut filepath: Option<String> = None;
    let mut file_iv: Option<String> = None;
    let mut size: i64 = 0;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;
        let field_name = field.name().to_string();

        if field_name == "e2e" {
            let mut bytes = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
                bytes.extend_from_slice(&data);
            }
            let raw = std::str::from_utf8(&bytes).unwrap_or("true").trim();
            e2e = raw != "false";
            continue;
        }

        if field_name != "file" {
            continue;
        }

        let cd = field.content_disposition();
        mime_type = field.content_type().map(|m| m.essence_str().to_string());
        let raw_filename = cd
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;
        let clean = raw_filename.replace(['/', '\\'], "");

        let uuid = Uuid::new_v4().to_string();
        let path = format!("{upload_dir}/{uuid}_{clean}");

        let mut plaintext = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            if size > MAX_ATTACHMENT_BYTES {
                return Ok(HttpResponse::PayloadTooLarge()
                    .json(serde_json::json!({ "message": "Attachment too large (max 25 MB)." })));
            }
            plaintext.extend_from_slice(&data);
        }

        let (iv, encrypted) = encrypt_binary(&plaintext).map_err(|e| {
            error!(target: "http", error = %e, "attachment encrypt failed");
            actix_web::error::ErrorInternalServerError("File encrypt error")
        })?;

        let mut f = fs::File::create(&path).await.map_err(|e| {
            error!(target: "http", path = %path, error = ?e, "attachment create failed");
            actix_web::error::ErrorInternalServerError("File create error")
        })?;
        f.write_all(&encrypted).await.map_err(|e| {
            error!(target: "http", path = %path, error = ?e, "attachment write failed");
            actix_web::error::ErrorInternalServerError("Write error")
        })?;

        filename = Some(clean);
        filepath = Some(path);
        file_iv = Some(iv);
    }

    let (Some(name), Some(path)) = (filename, filepath) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({ "message": "No file" })));
    };

    let row = sqlx::query(
        r#"
        INSERT INTO chat_attachments
            (message_id, uploader_id, filename, mime_type, size, file_path, file_iv, e2e)
        VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(&name)
    .bind(mime_type.as_deref())
    .bind(size)
    .bind(&path)
    .bind(file_iv.as_deref())
    .bind(e2e)
    .fetch_one(pool.get_ref())
    .await
    .map_err(|e| {
        error!(target: "http", user_id, error = ?e, "chat attachment insert failed");
        actix_web::error::ErrorInternalServerError("DB error")
    })?;

    let id: i64 = row.get("id");
    info!(target: "http", user_id, attachment_id = id, size, e2e, "chat attachment uploaded");

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": id,
        "filename": name,
        "mime_type": mime_type,
        "size": size,
        "e2e": e2e,
    })))
}

#[get("/chat/attachments/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_chat_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let attachment_id = path.into_inner();

    // Membership is re-checked on every download, so removing someone from a
    // channel also cuts off their access to its attachments.
    let row = sqlx::query(
        r#"
        SELECT a.filename, a.mime_type, a.file_path, a.file_iv
          FROM chat_attachments a
          LEFT JOIN messages m ON m.id = a.message_id
          LEFT JOIN channel_messages cm ON cm.id = a.channel_message_id
         WHERE a.id = $1
           AND ( a.uploader_id = $2
                 OR m.sender_id = $2
                 OR m.receiver_id = $2
                 OR EXISTS (
                        SELECT 1
                          FROM channel_members me
                         WHERE me.channel_id = cm.channel_id
                           AND me.user_id = $2
                    ) )
        "#,
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };

    let filename: String = row.get("filename");
    let mime_type: Option<String> = row.try_get("mime_type").ok().flatten();
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.try_get("file_iv").ok().flatten();

    let bytes = match fs::read(&file_path).await {
        Ok(b) => b,
        Err(e) => {
            error!(target: "http", user_id, attachment_id, error = ?e, "attachment read failed");
            return Ok(HttpResponse::NotFound().finish());
        }
    };

    // Strip the server at-rest layer. For an e2e upload the result is still the
    // client ciphertext, which only the browser can decrypt.
    let body = match file_iv.as_deref().filter(|v| !v.is_empty()) {
        Some(iv) => decrypt_binary(iv, &bytes)
            .map_err(|e| AppError::Internal(format!("attachment decrypt failed: {e}")))?,
        None => bytes,
    };

    let content_type = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(HttpResponse::Ok()
        .append_header((header::CONTENT_TYPE, content_type))
        .append_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "")),
        ))
        .body(body))
}
