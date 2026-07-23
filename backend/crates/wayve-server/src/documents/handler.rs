//! Organization Documents — a shared "Documents" dashboard.
//!
//! Unlike `drive` (files are user-owned, optionally E2E-encrypted to the
//! uploader), Documents belongs to an ORGANIZATION and EVERY member has full
//! read/write/delete access. Blobs are stored on disk under ./uploads encrypted
//! with the server at-rest key only — so the server can serve them to any
//! member. There is no per-user envelope (it would lock other members out).

use crate::billing::entitlements::effective_entitlements;
use crate::billing::resolve_owner;
use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::{Error, HttpResponse, web};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use sqlx::{FromRow, PgPool, Row};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{error, instrument};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const NAME_MAX: usize = 255;

#[derive(Deserialize)]
pub struct FolderQuery {
    /// List items in this folder. `None` → the Documents root.
    pub folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct ParentQuery {
    pub parent_folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct CreateFolderInput {
    pub name: String,
    pub parent_folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct RenameInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct CreateDocumentInput {
    pub name: String,
    #[serde(default)]
    pub content: String,
    pub folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateContentInput {
    pub content: String,
}

#[derive(Serialize, FromRow)]
struct DocumentFolder {
    id: i64,
    name: String,
    parent_folder_id: Option<i64>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, FromRow)]
struct DocumentFile {
    id: i64,
    name: String,
    file_type: Option<String>,
    size: i64,
    created_at: DateTime<Utc>,
}

/// The caller's `(user_id, scope)` for Documents. `scope` is the value matched
/// against `org_documents.organization_id`: `Some(org_id)` for an organization
/// member (their org's shared workspace) or `None` for platform team (the
/// platform-wide shared set — platform staff have no org). Personal accounts
/// get a 403. Callers bind `scope` (an `Option<i32>`) and match rows with
/// `organization_id IS NOT DISTINCT FROM $n`, so `None` matches the NULL rows.
async fn org_context(req: &HttpRequest, pool: &PgPool) -> Result<(i32, Option<i32>), HttpResponse> {
    let user_id = get_user_id_from_request(req).ok_or_else(|| {
        HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }))
    })?;
    let ctx = rbac::resolve_role_context(pool, user_id)
        .await
        .map_err(|e| {
            error!(target: "http", user_id, error = ?e, "documents role resolution failed");
            HttpResponse::InternalServerError().finish()
        })?;
    match (ctx.scope, ctx.organization_id) {
        (Scope::Organization, Some(org_id)) => Ok((user_id, Some(org_id))),
        (Scope::Platform, _) => Ok((user_id, None)),
        _ => Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Documents is a shared workspace for organization and platform members."
        }))),
    }
}

/// The caller's `(user_id, scope)` for a **mutating** Documents action.
/// Identical scoping to `org_context`, but additionally requires the
/// `documents:manage` permission — held by owner and super_admin only. Every
/// other member is read-only, so they get a 403 here while `org_context`
/// (list / view / download) still lets them through. A personal-account owner
/// holds the permission by role but has no shared workspace, so the scope match
/// below rejects them with the same 403 as `org_context`.
async fn require_docs_manage(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<(i32, Option<i32>), HttpResponse> {
    let ctx = rbac::require_permission(req, pool, Permission::DocumentsManage).await?;
    match (ctx.scope, ctx.organization_id) {
        (Scope::Organization, Some(org_id)) => Ok((ctx.user_id, Some(org_id))),
        (Scope::Platform, _) => Ok((ctx.user_id, None)),
        _ => Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Documents is a shared workspace for organization and platform members."
        }))),
    }
}

fn trimmed_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > NAME_MAX {
        None
    } else {
        Some(name.to_string())
    }
}

/// Which `collection` this request addresses. The same handler functions back
/// both the Documents ("library") page and the Skills ("skills") page — they are
/// mounted under `/skills*` / `/skill-folders*` as well as `/documents*` /
/// `/document-folders*` (see `mod.rs`), and the path tells them which tree they
/// operate on. Every SQL touch on `org_documents` / `org_document_folders` binds
/// this so the two trees never leak into each other's listings.
fn collection_for(req: &HttpRequest) -> &'static str {
    if req.path().contains("/skill") {
        "skills"
    } else {
        "library"
    }
}

#[derive(Serialize)]
struct SkillCatalogEntry {
    name: String,
    description: String,
    content: String,
}

/// The first paragraph of a SKILL.md YAML front-matter `description:` (which may
/// be a folded `>-` block spanning several indented lines), collapsed to one
/// line. Falls back to the first non-heading Markdown line, else empty.
fn skill_description(markdown: &str) -> String {
    let mut lines = markdown.lines();
    if lines.next().map(str::trim) == Some("---") {
        let mut collecting = false;
        let mut parts: Vec<String> = Vec::new();
        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if collecting {
                // The folded block ends at the next top-level `key:` line.
                if !line.starts_with(char::is_whitespace) && trimmed.contains(':') {
                    break;
                }
                if trimmed.is_empty() {
                    break;
                }
                parts.push(trimmed.to_string());
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("description:") {
                let rest = rest.trim().trim_start_matches(['>', '|', '-']).trim();
                if rest.is_empty() {
                    collecting = true;
                } else {
                    return rest.to_string();
                }
            }
        }
        if !parts.is_empty() {
            return parts.join(" ");
        }
    }
    markdown
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#') && *l != "---")
        .unwrap_or("")
        .to_string()
}

// GET /api/skills/catalog — the repository's built-in Claude skills, read from
// the skills directory (`CLAUDE_SKILLS_DIR`, default `.claude/skills`). These are
// the same for everyone and read-only; any workspace member may view them. A
// missing directory just yields an empty list, so a deploy without the skills
// checked out degrades quietly rather than erroring.
#[instrument(target = "http", skip(req, pool))]
pub async fn list_skill_catalog(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if org_context(&req, pool.get_ref()).await.is_err() {
        return Ok(HttpResponse::Ok().json(Vec::<SkillCatalogEntry>::new()));
    }

    let dir = std::env::var("CLAUDE_SKILLS_DIR").unwrap_or_else(|_| ".claude/skills".to_string());
    let mut entries: Vec<SkillCatalogEntry> = Vec::new();

    if let Ok(mut read_dir) = fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            // `metadata()` (not `file_type()`) follows symlinks — the skills live
            // behind per-skill symlinks in this repo.
            let is_dir = match fs::metadata(entry.path()).await {
                Ok(meta) => meta.is_dir(),
                Err(_) => continue,
            };
            if !is_dir {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_string();
            let skill_md = entry.path().join("SKILL.md");
            let Ok(content) = fs::read_to_string(&skill_md).await else {
                continue;
            };
            entries.push(SkillCatalogEntry {
                description: skill_description(&content),
                name: folder,
                content,
            });
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(HttpResponse::Ok().json(entries))
}

// GET /api/document-folders?parent_folder_id=N — folders at a level.
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_folders(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ParentQuery>,
) -> AppResult {
    let (_uid, org_id) = match org_context(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(_) => return Ok(HttpResponse::Ok().json(Vec::<DocumentFolder>::new())),
    };
    let collection = collection_for(&req);

    let rows = sqlx::query_as::<_, DocumentFolder>(
        "SELECT id, name, parent_folder_id, created_at
         FROM org_document_folders
         WHERE organization_id IS NOT DISTINCT FROM $1 AND collection = $2
           AND parent_folder_id IS NOT DISTINCT FROM $3
         ORDER BY name ASC",
    )
    .bind(org_id)
    .bind(collection)
    .bind(query.parent_folder_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

// POST /api/document-folders — create a folder (any org member).
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_folder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<CreateFolderInput>,
) -> AppResult {
    let (user_id, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let Some(name) = trimmed_name(&body.name) else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Folder name is required" })));
    };

    if let Some(parent_id) = body.parent_folder_id
        && !folder_in_org(pool.get_ref(), parent_id, org_id, collection).await?
    {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Parent folder not found" })));
    }

    let row = sqlx::query_as::<_, DocumentFolder>(
        "INSERT INTO org_document_folders (organization_id, collection, parent_folder_id, name, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, parent_folder_id, created_at",
    )
    .bind(org_id)
    .bind(collection)
    .bind(body.parent_folder_id)
    .bind(&name)
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(row))
}

// PATCH /api/document-folders/{id} — rename a folder (any org member).
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn rename_folder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
    body: web::Json<RenameInput>,
) -> AppResult {
    let (_uid, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let Some(name) = trimmed_name(&body.name) else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Folder name is required" })));
    };

    let updated: Option<i64> = sqlx::query_scalar(
        "UPDATE org_document_folders SET name = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id IS NOT DISTINCT FROM $3 AND collection = $4 RETURNING id",
    )
    .bind(&name)
    .bind(path.into_inner())
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    match updated {
        Some(_) => Ok(HttpResponse::Ok().json(serde_json::json!({ "renamed": true }))),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Folder not found" })))
        }
    }
}

// DELETE /api/document-folders/{id} — delete a folder + everything under it.
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_folder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let (_uid, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let folder_id = path.into_inner();

    // Collect on-disk paths for every file under this folder (recursively)
    // before the cascading DB delete, so we can unlink the blobs too — the FK
    // cascade only removes rows, not files. The recursion is bounded to the
    // starting folder's collection by its scoped anchor row.
    let paths: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE sub AS (
             SELECT id FROM org_document_folders
             WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3
             UNION ALL
             SELECT f.id FROM org_document_folders f JOIN sub ON f.parent_folder_id = sub.id
         )
         SELECT file_path FROM org_documents WHERE folder_id IN (SELECT id FROM sub)",
    )
    .bind(folder_id)
    .bind(org_id)
    .bind(collection)
    .fetch_all(pool.get_ref())
    .await?;

    let removed: Option<i64> = sqlx::query_scalar(
        "DELETE FROM org_document_folders WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3 RETURNING id",
    )
    .bind(folder_id)
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    if removed.is_none() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Folder not found" }))
        );
    }

    for p in paths {
        let _ = fs::remove_file(&p).await;
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

// GET /api/documents?folder_id=N — files at a level.
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_documents(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<FolderQuery>,
) -> AppResult {
    let (_uid, org_id) = match org_context(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(_) => return Ok(HttpResponse::Ok().json(Vec::<DocumentFile>::new())),
    };
    let collection = collection_for(&req);

    let rows = sqlx::query_as::<_, DocumentFile>(
        "SELECT id, name, file_type, size, created_at
         FROM org_documents
         WHERE organization_id IS NOT DISTINCT FROM $1 AND collection = $2
           AND folder_id IS NOT DISTINCT FROM $3
         ORDER BY created_at DESC",
    )
    .bind(org_id)
    .bind(collection)
    .bind(query.folder_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

// POST /api/documents — upload one or more files (any org member). Multipart:
// `files` parts + optional `folder_id` text field.
#[instrument(target = "http", skip(req, payload, pool))]
pub async fn upload_documents(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, Error> {
    let (user_id, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);

    // Storage limit is enforced against the org's billing entitlement only for
    // org-scoped uploads; the platform-wide shared set (scope None) isn't billed
    // per-org, so skip the entitlement lookup + running total entirely there.
    // The running total spans both collections (library + skills) since they
    // share the org's one storage budget.
    let (storage_limit_bytes, mut used): (i64, i64) = if org_id.is_some() {
        let owner = match resolve_owner(pool.get_ref(), user_id).await {
            Ok(owner) => owner,
            Err(resp) => return Ok(resp),
        };
        let entitlement = effective_entitlements(pool.get_ref(), owner).await;
        let used: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(size), 0)::BIGINT FROM org_documents WHERE organization_id IS NOT DISTINCT FROM $1",
        )
        .bind(org_id)
        .fetch_one(pool.get_ref())
        .await
        .map_err(|_| actix_web::error::ErrorInternalServerError("DB error"))?;
        (entitlement.storage_limit_bytes, used)
    } else {
        (-1, 0) // -1 = unlimited; platform-wide set is not capped here
    };

    let upload_dir = "./uploads";
    fs::create_dir_all(upload_dir)
        .await
        .map_err(|_| actix_web::error::ErrorInternalServerError("Dir error"))?;

    let mut folder_id: Option<i64> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| actix_web::error::ErrorBadRequest("Invalid multipart"))?;
        let field_name = field.name().to_string();

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
                let parsed = raw
                    .parse::<i64>()
                    .map_err(|_| actix_web::error::ErrorBadRequest("Invalid folder_id"))?;
                let in_org = folder_in_org(pool.get_ref(), parsed, org_id, collection)
                    .await
                    .map_err(|_| actix_web::error::ErrorInternalServerError("DB error"))?;
                if !in_org {
                    return Ok(HttpResponse::NotFound().body("Folder not found"));
                }
                folder_id = Some(parsed);
            }
            continue;
        }

        if field_name != "files" {
            continue;
        }

        let raw_filename = field
            .content_disposition()
            .get_filename()
            .ok_or_else(|| actix_web::error::ErrorBadRequest("Missing filename"))?;
        let filename = raw_filename.replace(['/', '\\'], "");

        let disk_id = Uuid::new_v4().to_string();
        let filepath = format!("{upload_dir}/{disk_id}_{filename}");

        let mut size: i64 = 0;
        let mut plaintext = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        // `storage_limit_bytes` is -1 (unlimited) for the platform-wide set, so
        // this check is naturally skipped there; it only bites org uploads.
        if storage_limit_bytes >= 0 && used.saturating_add(size) > storage_limit_bytes {
            return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
                "message": "Storage limit exceeded. Remove files or upgrade your plan.",
                "storage_limit_bytes": storage_limit_bytes,
                "storage_used_bytes": used,
                "upload_size_bytes": size
            })));
        }

        let (file_iv, encrypted_bytes) = encrypt_binary(&plaintext)
            .map_err(|_| actix_web::error::ErrorInternalServerError("Encrypt error"))?;
        let mut f = fs::File::create(&filepath)
            .await
            .map_err(|_| actix_web::error::ErrorInternalServerError("File create error"))?;
        f.write_all(&encrypted_bytes)
            .await
            .map_err(|_| actix_web::error::ErrorInternalServerError("Write error"))?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        sqlx::query(
            "INSERT INTO org_documents
             (organization_id, collection, folder_id, name, file_type, file_path, file_iv, size, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(org_id)
        .bind(collection)
        .bind(folder_id)
        .bind(&filename)
        .bind(&file_type)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .bind(user_id)
        .execute(pool.get_ref())
        .await
        .map_err(|_| actix_web::error::ErrorInternalServerError("DB error"))?;

        used = used.saturating_add(size);
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "uploaded": true })))
}

// GET /api/documents/{id}/download — stream a decrypted file to any org member.
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_document(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let (_uid, org_id) = match org_context(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);

    let row = sqlx::query(
        "SELECT name, file_path, file_iv FROM org_documents WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3",
    )
    .bind(path.into_inner())
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let name: String = row.get("name");
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.get("file_iv");

    match fs::read(&file_path).await {
        Ok(bytes) => {
            let body = match file_iv.as_deref().filter(|v| !v.is_empty()) {
                Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
                    error!(target: "http", error = %e, "document decrypt failed");
                    AppError::internal("document decrypt failed")
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
            error!(target: "http", path = %file_path, error = ?e, "document open failed");
            Ok(HttpResponse::NotFound().finish())
        }
    }
}

// PATCH /api/documents/{id} — rename a file (any org member).
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn rename_document(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
    body: web::Json<RenameInput>,
) -> AppResult {
    let (_uid, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let Some(name) = trimmed_name(&body.name) else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "File name is required" })));
    };

    let updated: Option<i64> = sqlx::query_scalar(
        "UPDATE org_documents SET name = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id IS NOT DISTINCT FROM $3 AND collection = $4 RETURNING id",
    )
    .bind(&name)
    .bind(path.into_inner())
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    match updated {
        Some(_) => Ok(HttpResponse::Ok().json(serde_json::json!({ "renamed": true }))),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "File not found" })))
        }
    }
}

// DELETE /api/documents/{id} — delete a file (any org member).
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_document(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let (_uid, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);

    let removed: Option<String> = sqlx::query_scalar(
        "DELETE FROM org_documents WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3 RETURNING file_path",
    )
    .bind(path.into_inner())
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    match removed {
        Some(file_path) => {
            let _ = fs::remove_file(&file_path).await;
            Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
        }
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "File not found" })))
        }
    }
}

// POST /api/documents/new — author a new text document in-app
// (owner/super_admin only). Body: { name, content, folder_id? }. The content is
// stored as an encrypted blob just like an upload, so download/view paths work
// unchanged.
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_document(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<CreateDocumentInput>,
) -> AppResult {
    let (user_id, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let Some(name) = trimmed_name(&body.name) else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "File name is required" })));
    };

    if let Some(folder_id) = body.folder_id
        && !folder_in_org(pool.get_ref(), folder_id, org_id, collection).await?
    {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Folder not found" }))
        );
    }

    let plaintext = body.content.as_bytes();
    let size = plaintext.len() as i64;

    // Enforce the org storage limit (the platform-wide set is uncapped).
    if org_id.is_some() {
        let owner = match resolve_owner(pool.get_ref(), user_id).await {
            Ok(owner) => owner,
            Err(resp) => return Ok(resp),
        };
        let entitlement = effective_entitlements(pool.get_ref(), owner).await;
        if entitlement.storage_limit_bytes >= 0 {
            let used: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(size), 0)::BIGINT FROM org_documents WHERE organization_id IS NOT DISTINCT FROM $1",
            )
            .bind(org_id)
            .fetch_one(pool.get_ref())
            .await?;
            if used.saturating_add(size) > entitlement.storage_limit_bytes {
                return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
                    "message": "Storage limit exceeded. Remove files or upgrade your plan.",
                    "storage_limit_bytes": entitlement.storage_limit_bytes,
                    "storage_used_bytes": used,
                })));
            }
        }
    }

    let upload_dir = "./uploads";
    fs::create_dir_all(upload_dir)
        .await
        .map_err(|_| AppError::internal("Dir error"))?;
    let disk_id = Uuid::new_v4().to_string();
    let safe_name = name.replace(['/', '\\'], "");
    let filepath = format!("{upload_dir}/{disk_id}_{safe_name}");

    let (file_iv, encrypted_bytes) =
        encrypt_binary(plaintext).map_err(|_| AppError::internal("Encrypt error"))?;
    let mut f = fs::File::create(&filepath)
        .await
        .map_err(|_| AppError::internal("File create error"))?;
    f.write_all(&encrypted_bytes)
        .await
        .map_err(|_| AppError::internal("Write error"))?;

    let file_type = match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => ext.to_string(),
        _ => "txt".to_string(),
    };

    let row = sqlx::query_as::<_, DocumentFile>(
        "INSERT INTO org_documents
         (organization_id, collection, folder_id, name, file_type, file_path, file_iv, size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, file_type, size, created_at",
    )
    .bind(org_id)
    .bind(collection)
    .bind(body.folder_id)
    .bind(&name)
    .bind(&file_type)
    .bind(&filepath)
    .bind(&file_iv)
    .bind(size)
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(row))
}

// GET /api/documents/{id}/content — decrypted text for in-app viewing/editing.
// Read access: any org/platform member (read-only members included).
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_document_content(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let (_uid, org_id) = match org_context(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);

    let row = sqlx::query(
        "SELECT name, file_path, file_iv FROM org_documents WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3",
    )
    .bind(path.into_inner())
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let name: String = row.get("name");
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.get("file_iv");

    let bytes = match fs::read(&file_path).await {
        Ok(b) => b,
        Err(_) => return Ok(HttpResponse::NotFound().finish()),
    };
    let plaintext = match file_iv.as_deref().filter(|v| !v.is_empty()) {
        Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
            error!(target: "http", error = %e, "document decrypt failed");
            AppError::internal("document decrypt failed")
        })?,
        None => bytes,
    };
    let content = String::from_utf8_lossy(&plaintext).to_string();
    Ok(HttpResponse::Ok().json(serde_json::json!({ "name": name, "content": content })))
}

// PUT /api/documents/{id}/content — overwrite a document's content
// (owner/super_admin only). Re-encrypts the blob in place and updates the size.
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn update_document_content(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
    body: web::Json<UpdateContentInput>,
) -> AppResult {
    let (_uid, org_id) = match require_docs_manage(&req, pool.get_ref()).await {
        Ok(v) => v,
        Err(resp) => return Ok(resp),
    };
    let collection = collection_for(&req);
    let id = path.into_inner();

    let file_path: Option<String> = sqlx::query_scalar(
        "SELECT file_path FROM org_documents WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3",
    )
    .bind(id)
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(file_path) = file_path else {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "File not found" }))
        );
    };

    let plaintext = body.content.as_bytes();
    let size = plaintext.len() as i64;
    let (file_iv, encrypted_bytes) =
        encrypt_binary(plaintext).map_err(|_| AppError::internal("Encrypt error"))?;
    let mut f = fs::File::create(&file_path)
        .await
        .map_err(|_| AppError::internal("File create error"))?;
    f.write_all(&encrypted_bytes)
        .await
        .map_err(|_| AppError::internal("Write error"))?;

    sqlx::query(
        "UPDATE org_documents SET file_iv = $1, size = $2, updated_at = NOW()
         WHERE id = $3 AND organization_id IS NOT DISTINCT FROM $4 AND collection = $5",
    )
    .bind(&file_iv)
    .bind(size)
    .bind(id)
    .bind(org_id)
    .bind(collection)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": true })))
}

/// Whether `folder_id` exists within the caller's scope (`Some(org)` or the
/// platform-wide `None` set) **and** the given `collection` — so a library
/// folder id can't be used to file a skills document under it, or vice versa.
async fn folder_in_org(
    pool: &PgPool,
    folder_id: i64,
    org_id: Option<i32>,
    collection: &str,
) -> Result<bool, AppError> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM org_document_folders WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2 AND collection = $3",
    )
    .bind(folder_id)
    .bind(org_id)
    .bind(collection)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}
