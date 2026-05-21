// Drive folder routes.
//
// Endpoints:
//   POST   /api/folders                       — create folder
//   GET    /api/folders?parent_folder_id=N    — list children of N (NULL = root)
//   DELETE /api/folders/{id}                  — delete folder + cascade to
//                                                children + files
//
// Tenant gate on every endpoint: rows are joined / filtered on
// `folders.user_id = <jwt user_id>`. A 404 (not 403) is returned for
// folders owned by other users so the API doesn't leak existence.

use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{HttpResponse, delete, get, post, web};
use chrono::NaiveDateTime;
use sqlx::{FromRow, PgPool, Row};
use tracing::{debug, instrument};

#[derive(Serialize, FromRow)]
pub struct Folder {
    pub id: i64,
    pub user_id: i32,
    pub parent_folder_id: Option<i64>,
    pub name: String,
    pub created_at: NaiveDateTime,
}

#[derive(Deserialize)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_folder_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct ListFoldersQuery {
    /// Filter to folders whose parent matches. `None` returns root-level
    /// folders. Honoring the explicit-NULL semantics keeps the URL shape
    /// orthogonal to the file list (which uses the same convention).
    pub parent_folder_id: Option<i64>,
}

#[post("/folders")]
#[instrument(target = "http", skip(req, body, pool))]
pub async fn create_folder(
    req: HttpRequest,
    body: web::Json<CreateFolderRequest>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let name = body.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "Folder name is required" })));
    }
    // Cap at a generous-but-bounded length so a malicious client can't store
    // megabytes of "name". DB column is TEXT (unbounded) but reasonable UIs
    // produce <= 255 chars.
    if name.chars().count() > 255 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "Folder name is too long (max 255 chars)" })));
    }

    // If parent is given, verify it exists AND belongs to this user. Without
    // this check a user could nest folders under another user's parent —
    // wouldn't expose data, but corrupts the tree and surfaces foreign rows
    // through the parent lookup.
    if let Some(parent_id) = body.parent_folder_id {
        let owns_parent: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        )
        .bind(parent_id)
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?;
        if owns_parent.is_none() {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "error": "Parent folder not found" })));
        }
    }

    let row = sqlx::query(
        r#"
        INSERT INTO folders (user_id, parent_folder_id, name)
        VALUES ($1, $2, $3)
        RETURNING id, user_id, parent_folder_id, name, created_at
        "#,
    )
    .bind(user_id)
    .bind(body.parent_folder_id)
    .bind(name)
    .fetch_one(pool.get_ref())
    .await?;

    let folder = Folder {
        id: row.get("id"),
        user_id: row.get("user_id"),
        parent_folder_id: row.get("parent_folder_id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
    };

    debug!(target: "http", user_id, folder_id = folder.id, "folder created");
    Ok(HttpResponse::Ok().json(folder))
}

#[get("/folders")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_folders(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ListFoldersQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // `parent_folder_id IS NOT DISTINCT FROM $2` matches NULL when the param
    // is NULL — Postgres's regular `=` returns NULL on NULL operands, which
    // would silently drop the root-level case.
    let rows = sqlx::query_as::<_, Folder>(
        r#"
        SELECT id, user_id, parent_folder_id, name, created_at
          FROM folders
         WHERE user_id = $1
           AND parent_folder_id IS NOT DISTINCT FROM $2
         ORDER BY name ASC
        "#,
    )
    .bind(user_id)
    .bind(query.parent_folder_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[delete("/folders/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_folder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let folder_id = path.into_inner();

    // DELETE ... RETURNING combines the ownership check, delete, and "did
    // anything happen?" check into one round-trip. The FK ON DELETE CASCADE
    // on both `folders.parent_folder_id` and `files.folder_id` removes any
    // descendants in the same transaction.
    let removed: Option<i64> = sqlx::query_scalar(
        "DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING id",
    )
    .bind(folder_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if removed.is_none() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "error": "Folder not found" }))
        );
    }

    debug!(target: "http", user_id, folder_id, "folder deleted");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
