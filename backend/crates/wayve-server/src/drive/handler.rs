use crate::billing::models::BillingOwner;
use crate::billing::{entitlements::effective_entitlements, resolve_owner, usage_metering};
use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::{Error, HttpResponse, delete, get, patch, web};
use chrono::NaiveDateTime;
use futures_util::StreamExt;
use sqlx::{FromRow, PgPool, Row};
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};
use wayve_security::jwt::get_user_id_from_request;

#[derive(Deserialize)]
pub struct FilesQuery {
    /// Filter to files in this folder. `None` means the drive root, with the
    /// same NULL-distinct semantics as `folders::list_folders`.
    pub folder_id: Option<i64>,
}

#[derive(Serialize)]
struct FileResponse {
    id: i64,
    name: String,
    file_type: String,
    size: i64,
    drive_url: String,
    created_at: NaiveDateTime,
    shared: bool,
    permission: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct FileRecord {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub file_iv: Option<String>,
    pub size: i64,
    pub created_at: NaiveDateTime,
}

// Blobs are written to disk encrypted at rest (AES-GCM, per-file IV stored in
// `drive_files.file_iv`) and are never served statically; reads go through the
// authenticated `/api/files/{id}/download` handler below.
#[instrument(target = "http", skip(req, payload, pool))]
pub async fn upload_file(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, Error> {
    // Owner comes from the verified JWT, never the request body; a `user_id`
    // form field, if present, is ignored.
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    let entitlement = effective_entitlements(pool.get_ref(), owner).await;
    let mut current_storage = drive_storage_used(pool.get_ref(), owner)
        .await
        .map_err(|e| {
            error!(target: "http", user_id, error = ?e, "drive storage usage lookup failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

    // Optional target folder, sent as a plain text part alongside the files and
    // validated once below before any INSERT happens.
    let mut folder_id: Option<i64> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;

        let field_name = field.name().to_string();

        // Multipart fields may arrive in any order, but browsers send non-file
        // fields first, so `folder_id` lands before the `files` parts.
        if field_name == "folder_id" {
            let mut bytes = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
                bytes.extend_from_slice(&data);
            }
            let raw = std::str::from_utf8(&bytes)
                .map_err(|_| actix_web::error::ErrorBadRequest("Invalid folder_id"))?
                .trim();
            if !raw.is_empty() {
                folder_id = Some(
                    raw.parse::<i64>()
                        .map_err(|_| actix_web::error::ErrorBadRequest("Invalid folder_id"))?,
                );
                // Tenant gate: confirm the folder belongs to this user.
                let owns: Option<i64> =
                    sqlx::query_scalar("SELECT id FROM folders WHERE id = $1 AND user_id = $2")
                        .bind(folder_id.unwrap_or(0))
                        .bind(user_id)
                        .fetch_optional(pool.get_ref())
                        .await
                        .map_err(|e| {
                            error!(target: "http", error = ?e, "folder ownership check failed");
                            actix_web::error::ErrorInternalServerError("DB error")
                        })?;
                if owns.is_none() {
                    return Ok(HttpResponse::NotFound().body("Folder not found"));
                }
            }
            continue;
        }

        if field_name != "files" {
            continue;
        }

        let content_disposition = field.content_disposition();

        let raw_filename = content_disposition
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;

        // Strip path separators so an uploaded name cannot escape upload_dir.
        let filename = raw_filename.replace(['/', '\\'], "");

        let file_id = Uuid::new_v4().to_string();
        let filepath = crate::storage::stored_path(&format!("{file_id}_{filename}"));

        let mut size: i64 = 0;
        let mut plaintext = Vec::new();

        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;

            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        if entitlement.storage_limit_bytes >= 0
            && current_storage.saturating_add(size) > entitlement.storage_limit_bytes
        {
            return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
                "message": "Storage limit exceeded. Upgrade your plan or remove files to upload more.",
                "storage_limit_bytes": entitlement.storage_limit_bytes,
                "storage_used_bytes": current_storage,
                "upload_size_bytes": size
            })));
        }

        let (file_iv, encrypted_bytes) = encrypt_binary(&plaintext).map_err(|e| {
            error!(target: "http", error = %e, "file encrypt failed");
            actix_web::error::ErrorInternalServerError("File encrypt error")
        })?;

        crate::storage::put(&filepath, encrypted_bytes)
            .await
            .map_err(|e| {
                error!(target: "http", path = %filepath, error = %e, "file write failed");
                actix_web::error::ErrorInternalServerError("Write error")
            })?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        sqlx::query(
            r#"
            INSERT INTO drive_files (name, file_path, file_iv, size, file_type, user_id, folder_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(&filename)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .bind(&file_type)
        .bind(user_id)
        .bind(folder_id)
        .execute(pool.get_ref())
        .await
        .map_err(|e| {
            error!("Files insert failed (user_id={}): {:?}", user_id, e);
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

        info!(
            "File uploaded: name=\"{}\" size={} user_id={}",
            filename, size, user_id
        );

        let folder = audit_folder_name(pool.get_ref(), folder_id).await;
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "file_upload",
                resource_type: "drive_file",
                resource_id: None,
                metadata: Some(serde_json::json!({
                    "name": filename.clone(),
                    "size": size,
                    "folder_id": folder_id,
                    "folder": folder,
                })),
            },
        )
        .await;
        current_storage = current_storage.saturating_add(size);
        let _ =
            usage_metering::record_event(pool.get_ref(), owner, "drive_storage_bytes", size).await;
    }

    Ok(HttpResponse::Ok().body("Upload successful"))
}

#[get("/files")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_files(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<FilesQuery>,
) -> AppResult {
    // Files are scoped to the authenticated user; never accept a caller-supplied
    // user id here. An absent `?folder_id=` means the drive root, i.e. rows
    // where folder_id IS NULL, which `IS NOT DISTINCT FROM` handles in one query.
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let folder_id = query.folder_id;

    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query_as::<_, FileRecord>(
            "SELECT id, name, file_path, file_iv, size, created_at \
               FROM drive_files \
              WHERE user_id = $1 \
                AND folder_id IS NOT DISTINCT FROM $2 \
              ORDER BY created_at DESC",
        )
        .bind(user_id)
        .bind(folder_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    debug!(target: "http", user_id, count = rows.len(), "files listed");

    let files: Vec<FileResponse> = rows
        .into_iter()
        .map(|row| {
            let file_type = row.name.split('.').next_back().unwrap_or("").to_string();

            FileResponse {
                id: row.id,
                name: row.name,
                file_type,
                size: row.size,
                drive_url: format!("/api/files/{}/download", row.id),
                created_at: row.created_at,
                shared: false,
                permission: None,
            }
        })
        .collect();

    Ok(HttpResponse::Ok().json(files))
}

// The only read path for a blob: files are not served statically, so every
// download is authenticated, ownership-checked, and decrypted here.
#[get("/files/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_file(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let file_id = path.into_inner();

    // The row is returned only when it belongs to the caller, so the 404 leaks
    // nothing about other users' files.
    let row = sqlx::query(
        "SELECT name, file_path, file_iv, size, folder_id \
           FROM drive_files WHERE id = $1 AND user_id = $2",
    )
    .bind(file_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let (file_name, file_path, file_iv, size, folder_id): (
        String,
        String,
        Option<String>,
        i64,
        Option<i64>,
    ) = match row {
        Some(row) => (
            row.get("name"),
            row.get("file_path"),
            row.get("file_iv"),
            row.get("size"),
            row.get("folder_id"),
        ),
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    let folder = audit_folder_name(pool.get_ref(), folder_id).await;
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "file_download",
            resource_type: "drive_file",
            resource_id: Some(file_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": file_name.clone(),
                "size": size,
                "folder_id": folder_id,
                "folder": folder,
            })),
        },
    )
    .await;

    serve_file_parts(user_id, file_id, file_name, file_path, file_iv).await
}

#[derive(Deserialize)]
pub struct RenameFileRequest {
    pub name: String,
}

#[patch("/files/{id}")]
#[instrument(target = "http", skip(req, body, pool, path))]
pub async fn rename_file(
    req: HttpRequest,
    body: web::Json<RenameFileRequest>,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let file_id = path.into_inner();

    // `name` is a display label only; the on-disk path is keyed by a UUID and
    // never changes here. Strip separators anyway.
    let name = body.name.replace(['/', '\\'], "");
    let name = name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "File name is required" })));
    }
    if name.chars().count() > 255 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "File name is too long (max 255 chars)" })));
    }

    // Must match what `get_files` recomputes from the name on read.
    let file_type = name.rsplit('.').next().unwrap_or("").to_string();

    let prior: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT name, folder_id FROM drive_files WHERE id = $1 AND user_id = $2")
            .bind(file_id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    // UPDATE ... RETURNING folds the ownership and existence checks into one
    // round-trip. Returning 404 rather than 403 avoids leaking other users' rows.
    let updated: Option<i64> = sqlx::query_scalar(
        "UPDATE drive_files SET name = $1, file_type = $2 \
           WHERE id = $3 AND user_id = $4 RETURNING id",
    )
    .bind(name)
    .bind(&file_type)
    .bind(file_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if updated.is_none() {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "error": "File not found" })));
    }

    let (old_name, folder_id) = prior.unwrap_or_default();
    let folder = audit_folder_name(pool.get_ref(), folder_id).await;
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "file_rename",
            resource_type: "drive_file",
            resource_id: Some(file_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": name,
                "old_name": old_name,
                "folder_id": folder_id,
                "folder": folder,
            })),
        },
    )
    .await;

    debug!(target: "http", user_id, file_id, "file renamed");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "id": file_id, "name": name })))
}

#[delete("/files/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_file(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let file_id = path.into_inner();

    // DELETE ... RETURNING folds the ownership and existence checks into one
    // round-trip and hands back the path and size needed to remove the blob and
    // decrement storage usage.
    let row = sqlx::query(
        "DELETE FROM drive_files WHERE id = $1 AND user_id = $2 \
         RETURNING file_path, size, name, folder_id",
    )
    .bind(file_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let (file_path, size, file_name, folder_id): (String, i64, String, Option<i64>) = match row {
        Some(row) => (
            row.get("file_path"),
            row.get("size"),
            row.get("name"),
            row.get("folder_id"),
        ),
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "error": "File not found" }))
            );
        }
    };

    // Blob removal is best-effort: the row is already gone, so a stray file on
    // disk is unreachable and harmless. Log it, but do not fail the request.
    if let Err(e) = crate::storage::delete(&file_path).await {
        warn!(target: "http", user_id, file_id, path = %file_path, error = %e, "delete_file blob remove failed");
    }

    if let Ok(owner) = resolve_owner(pool.get_ref(), user_id).await {
        let _ =
            usage_metering::record_event(pool.get_ref(), owner, "drive_storage_bytes", -size).await;
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "file_delete",
            resource_type: "drive_file",
            resource_id: Some(file_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": file_name,
                "size": size,
                "folder_id": folder_id,
                "folder": audit_folder_name(pool.get_ref(), folder_id).await,
            })),
        },
    )
    .await;

    debug!(target: "http", user_id, file_id, "file deleted");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

/// Best-effort folder-name lookup for audit metadata. `None` for root or a
/// missing folder.
async fn audit_folder_name(pool: &PgPool, folder_id: Option<i64>) -> Option<String> {
    let id = folder_id?;
    sqlx::query_scalar::<_, String>("SELECT name FROM folders WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn serve_file_parts(
    user_id: i32,
    file_id: i64,
    file_name: String,
    file_path: String,
    file_iv: Option<String>,
) -> AppResult {
    match crate::storage::get(&file_path).await {
        Ok(bytes) => {
            let body = match file_iv.as_deref().filter(|value| !value.is_empty()) {
                Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
                    AppError::Internal(format!("download_file decrypt failed: {e}"))
                })?,
                None => bytes,
            };

            Ok(HttpResponse::Ok()
                .append_header((header::CONTENT_TYPE, "application/octet-stream"))
                .append_header((
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", file_name.replace('"', "")),
                ))
                .body(body))
        }
        Err(e) => {
            error!(target: "http", user_id, file_id, error = %e, "download_file open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

async fn drive_storage_used(pool: &PgPool, owner: BillingOwner) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(f.size), 0)::BIGINT
          FROM drive_files f
          JOIN users u ON u.id = f.user_id
         WHERE ($1::int IS NOT NULL AND f.user_id = $1)
            OR ($2::int IS NOT NULL AND u.organization_id = $2)
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_one(pool)
    .await
}

#[cfg(test)]
mod auth_regression_tests {
    use super::*;
    use actix_web::{App, http::StatusCode, test, web};
    use sqlx::postgres::PgPoolOptions;

    fn lazy_pool() -> PgPool {
        PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@localhost/rwayve_test")
            .expect("lazy pool")
    }

    #[actix_web::test]
    async fn upload_file_requires_auth() {
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .route("/files", web::post().to(upload_file)),
        )
        .await;

        let req = test::TestRequest::post().uri("/files").to_request();
        let resp = test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn get_files_requires_auth_even_with_user_id_query() {
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(get_files),
        )
        .await;

        let req = test::TestRequest::get()
            .uri("/files?user_id=123")
            .to_request();
        let resp = test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn download_file_requires_auth() {
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(download_file),
        )
        .await;

        let req = test::TestRequest::get()
            .uri("/files/1/download")
            .to_request();
        let resp = test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
