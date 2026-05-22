use crate::billing::models::BillingOwner;
use crate::billing::{entitlements::effective_entitlements, resolve_owner, usage_metering};
use crate::prelude::*;
use crate::security::encryption::{decrypt_binary, encrypt_binary};
use crate::security::jwt::get_user_id_from_request;
use crate::security::rbac::{self, Scope};
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::{Error, HttpResponse, get, post, web};
use chrono::NaiveDateTime;
use futures_util::StreamExt;
use sqlx::{FromRow, PgPool, Row};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{debug, error, info, instrument};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct FilesQuery {
    /// Filter to files in this folder. `None` → files at drive root.
    /// Same NULL-distinct semantics as `folders::list_folders`.
    pub folder_id: Option<i64>,
}

//
// ✅ RESPONSE STRUCT
//
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
struct SharedDriveItem {
    id: i64,
    resource_type: String,
    name: String,
    file_type: Option<String>,
    size: Option<i64>,
    permission: String,
    owner_user_id: i32,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
pub struct ShareDriveInput {
    pub scope: String,
    pub permission: String,
}

//
// ✅ DB STRUCT
//
#[derive(Serialize, FromRow)]
pub struct FileRecord {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub file_iv: Option<String>,
    pub size: i64,
    pub created_at: NaiveDateTime,
}

//
// 🔥 UPDATED UPLOAD FILE (FIXED USER_ID)
//
#[post("/files/upload")]
#[instrument(target = "http", skip(req, payload, pool))]
pub async fn upload_file(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, Error> {
    // Owner is derived from the verified JWT, never from the request body —
    // a `user_id` form field (if any) is ignored.
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

    let upload_dir = "./uploads";

    fs::create_dir_all(upload_dir).await.map_err(|e| {
        error!(target: "http", error = ?e, "upload dir create failed");
        actix_web::error::ErrorInternalServerError("Dir error")
    })?;

    // Optional target folder. Multipart forms send this as a regular text
    // field alongside the file parts. Collected in the loop below and
    // validated once before any INSERTs happen.
    let mut folder_id: Option<i64> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;

        let field_name = field.name().to_string();

        // Pick up `folder_id` (text field) before the `files` parts arrive.
        // Multipart fields can be interleaved in arbitrary order, but in
        // practice browsers send non-file fields first.
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

        // ✅ FILES ONLY (any other field, e.g. a stray user_id, is skipped)
        if field_name != "files" {
            continue;
        }

        let content_disposition = field.content_disposition();

        let raw_filename = content_disposition
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;

        // ✅ sanitize
        let filename = raw_filename.replace(['/', '\\'], "");

        let file_id = Uuid::new_v4().to_string();
        let filepath = format!("{}/{}_{}", upload_dir, file_id, filename);

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

        let mut f = fs::File::create(&filepath).await.map_err(|e| {
            error!(target: "http", path = %filepath, error = ?e, "file create failed");
            actix_web::error::ErrorInternalServerError("File create error")
        })?;

        f.write_all(&encrypted_bytes).await.map_err(|e| {
            error!(target: "http", path = %filepath, error = ?e, "file write failed");
            actix_web::error::ErrorInternalServerError("Write error")
        })?;

        // ✅ better file type extraction
        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        sqlx::query(
            r#"
            INSERT INTO files (name, file_path, file_iv, size, file_type, user_id, folder_id)
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
        current_storage = current_storage.saturating_add(size);
        let _ =
            usage_metering::record_event(pool.get_ref(), owner, "drive_storage_bytes", size).await;
    }

    Ok(HttpResponse::Ok().body("Upload successful"))
}

//
// ✅ GET FILES
//
#[get("/files")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_files(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<FilesQuery>,
) -> AppResult {
    // Files are scoped to the authenticated user — the previous `?user_id=`
    // query param let any caller list anyone's files. The new `?folder_id=`
    // optionally narrows to a specific folder; absence means "drive root"
    // (rows where folder_id IS NULL). `IS NOT DISTINCT FROM` handles the
    // NULL case in a single query.
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query_as::<_, FileRecord>(
        "SELECT id, name, file_path, file_iv, size, created_at \
           FROM files \
          WHERE user_id = $1 \
            AND folder_id IS NOT DISTINCT FROM $2 \
          ORDER BY created_at DESC",
    )
    .bind(user_id)
    .bind(query.folder_id)
    .fetch_all(pool.get_ref())
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
                // Authenticated, ownership-checked download route.
                drive_url: format!("/api/files/{}/download", row.id),
                created_at: row.created_at,
                shared: false,
                permission: None,
            }
        })
        .collect();

    Ok(HttpResponse::Ok().json(files))
}

#[get("/drive/shared")]
#[instrument(target = "http", skip(req, pool))]
pub async fn shared_drive_items(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), rbac::Permission::AppsUse).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope == Scope::Personal {
        return Ok(HttpResponse::Ok().json(Vec::<SharedDriveItem>::new()));
    }

    let rows = sqlx::query_as::<_, SharedDriveItem>(
        r#"
        SELECT ds.resource_id AS id,
               ds.resource_type,
               CASE WHEN ds.resource_type = 'file' THEN f.name ELSE fo.name END AS name,
               CASE WHEN ds.resource_type = 'file' THEN f.file_type ELSE NULL END AS file_type,
               CASE WHEN ds.resource_type = 'file' THEN f.size ELSE NULL END AS size,
               ds.permission,
               COALESCE(f.user_id, fo.user_id) AS owner_user_id,
               ds.created_at
          FROM drive_shares ds
          LEFT JOIN files f ON ds.resource_type = 'file' AND f.id = ds.resource_id
          LEFT JOIN folders fo ON ds.resource_type = 'folder' AND fo.id = ds.resource_id
         WHERE (
             ($1 = 'organization' AND ds.scope = 'organization' AND ds.organization_id = $2)
             OR ($1 = 'platform' AND ds.scope = 'platform')
         )
           AND COALESCE(f.user_id, fo.user_id) IS NOT NULL
           AND COALESCE(f.user_id, fo.user_id) <> $3
         ORDER BY ds.created_at DESC
        "#,
    )
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .bind(ctx.user_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[post("/files/{id}/share")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn share_file(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
    body: web::Json<ShareDriveInput>,
) -> AppResult {
    share_resource(req, pool, "file", path.into_inner(), body).await
}

#[post("/folders/{id}/share")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn share_folder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
    body: web::Json<ShareDriveInput>,
) -> AppResult {
    share_resource(req, pool, "folder", path.into_inner(), body).await
}

async fn share_resource(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    resource_type: &str,
    resource_id: i64,
    body: web::Json<ShareDriveInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), rbac::Permission::AppsUse).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope == Scope::Personal {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Drive sharing is available for organization and platform workspaces"
        })));
    }
    let scope = body.scope.trim();
    let permission = body.permission.trim();
    if !matches!(scope, "organization" | "platform") || !matches!(permission, "view" | "edit") {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "scope must be organization/platform and permission must be view/edit"
        })));
    }
    if scope == "platform" && ctx.scope != Scope::Platform {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only platform users can create platform-wide Drive shares"
        })));
    }

    let owns = match resource_type {
        "file" => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT id FROM files WHERE id = $1 AND user_id = $2",
        )
        .bind(resource_id)
        .bind(ctx.user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .flatten(),
        _ => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        )
        .bind(resource_id)
        .bind(ctx.user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .flatten(),
    };
    if owns.is_none() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Drive item not found" }))
        );
    }

    let organization_id = if scope == "organization" {
        ctx.organization_id
    } else {
        None
    };
    sqlx::query(
        r#"
        INSERT INTO drive_shares (resource_type, resource_id, scope, organization_id, permission, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (resource_type, resource_id, scope, (COALESCE(organization_id, 0)))
        DO UPDATE SET permission = EXCLUDED.permission, created_by = EXCLUDED.created_by, created_at = NOW()
        "#,
    )
    .bind(resource_type)
    .bind(resource_id)
    .bind(scope)
    .bind(organization_id)
    .bind(permission)
    .bind(ctx.user_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "shared": true })))
}

#[get("/drive/shared/files/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_shared_file(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), rbac::Permission::AppsUse).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let file_id = path.into_inner();
    let row = sqlx::query(
        r#"
        SELECT f.name, f.file_path, f.file_iv
          FROM files f
          JOIN drive_shares ds ON ds.resource_type = 'file' AND ds.resource_id = f.id
         WHERE f.id = $1
           AND f.user_id <> $2
           AND (
             ($3 = 'organization' AND ds.scope = 'organization' AND ds.organization_id = $4)
             OR ($3 = 'platform' AND ds.scope = 'platform')
           )
         LIMIT 1
        "#,
    )
    .bind(file_id)
    .bind(ctx.user_id)
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    serve_file_row(ctx.user_id, file_id, row).await
}

//
// 🔥 AUTHENTICATED DOWNLOAD
//
#[get("/files/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_file(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let file_id = path.into_inner();

    // Ownership check: the row is only returned when it belongs to the caller,
    // so a 404 leaks nothing about other users' files.
    let row =
        sqlx::query("SELECT name, file_path, file_iv FROM files WHERE id = $1 AND user_id = $2")
            .bind(file_id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    let (file_name, file_path, file_iv): (String, String, Option<String>) = match row {
        Some(row) => (row.get("name"), row.get("file_path"), row.get("file_iv")),
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    serve_file_parts(user_id, file_id, file_name, file_path, file_iv).await
}

async fn serve_file_row(user_id: i32, file_id: i64, row: sqlx::postgres::PgRow) -> AppResult {
    serve_file_parts(
        user_id,
        file_id,
        row.get("name"),
        row.get("file_path"),
        row.get("file_iv"),
    )
    .await
}

async fn serve_file_parts(
    user_id: i32,
    file_id: i64,
    file_name: String,
    file_path: String,
    file_iv: Option<String>,
) -> AppResult {
    match fs::read(&file_path).await {
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
            error!(target: "http", user_id, file_id, error = ?e, "download_file open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

async fn drive_storage_used(pool: &PgPool, owner: BillingOwner) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(SUM(f.size), 0)::BIGINT
          FROM files f
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
                .service(upload_file),
        )
        .await;

        let req = test::TestRequest::post().uri("/files/upload").to_request();
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
