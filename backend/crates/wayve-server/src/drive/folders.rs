// Drive folder routes. Every endpoint is tenant-gated: rows are filtered on
// `folders.user_id = <jwt user_id>`, and a folder owned by another user returns
// 404 rather than 403 so the API does not leak its existence. Deleting a folder
// cascades to its child folders and files.

use crate::prelude::*;
use actix_web::{HttpResponse, delete, get, patch, post, web};
use chrono::NaiveDateTime;
use sqlx::{FromRow, PgPool, Row};
use tracing::{debug, instrument};
use wayve_security::jwt::get_user_id_from_request;

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
pub struct RenameFolderRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ListFoldersQuery {
    /// Filter to folders whose parent matches. `None` returns root-level
    /// folders, the same NULL convention the file list uses.
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
    // The column is unbounded TEXT, so cap the length here to stop a malicious
    // client storing megabytes of "name".
    if name.chars().count() > 255 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "Folder name is too long (max 255 chars)" })));
    }

    // A given parent must exist and belong to this user. Without the check, a
    // user could nest folders under another user's parent, corrupting the tree
    // and surfacing foreign rows through the parent lookup.
    if let Some(parent_id) = body.parent_folder_id {
        let owns_parent: Option<i64> =
            sqlx::query_scalar("SELECT id FROM folders WHERE id = $1 AND user_id = $2")
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

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "folder_create",
            resource_type: "folder",
            resource_id: Some(folder.id.to_string()),
            metadata: Some(serde_json::json!({
                "name": folder.name.clone(),
                "folder_id": folder.id,
                "parent_folder_id": folder.parent_folder_id,
            })),
        },
    )
    .await;

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
    let parent_folder_id = query.parent_folder_id;

    // `IS NOT DISTINCT FROM` matches NULL against NULL. A plain `=` yields NULL
    // on NULL operands, which would silently drop the root-level case.
    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
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
        .bind(parent_folder_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[patch("/folders/{id}")]
#[instrument(target = "http", skip(req, body, pool, path))]
pub async fn rename_folder(
    req: HttpRequest,
    body: web::Json<RenameFolderRequest>,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let folder_id = path.into_inner();

    let name = body.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "Folder name is required" })));
    }
    if name.chars().count() > 255 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "Folder name is too long (max 255 chars)" })));
    }

    let old_name: Option<String> =
        sqlx::query_scalar("SELECT name FROM folders WHERE id = $1 AND user_id = $2")
            .bind(folder_id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    // UPDATE ... RETURNING folds the ownership and existence checks into one
    // round-trip. Returning 404 rather than 403 avoids leaking other users' rows.
    let updated: Option<i64> = sqlx::query_scalar(
        "UPDATE folders SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id",
    )
    .bind(name)
    .bind(folder_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if updated.is_none() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "error": "Folder not found" }))
        );
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "folder_rename",
            resource_type: "folder",
            resource_id: Some(folder_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": name,
                "old_name": old_name,
                "folder_id": folder_id,
            })),
        },
    )
    .await;

    debug!(target: "http", user_id, folder_id, "folder renamed");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "id": folder_id, "name": name })))
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

    // DELETE ... RETURNING folds the ownership and existence checks into one
    // round-trip. The ON DELETE CASCADE on `folders.parent_folder_id` and
    // `files.folder_id` removes descendants in the same transaction.
    let removed: Option<String> =
        sqlx::query_scalar("DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING name")
            .bind(folder_id)
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    let Some(folder_name) = removed else {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "error": "Folder not found" }))
        );
    };

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "folder_delete",
            resource_type: "folder",
            resource_id: Some(folder_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": folder_name,
                "folder_id": folder_id,
            })),
        },
    )
    .await;

    debug!(target: "http", user_id, folder_id, "folder deleted");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
