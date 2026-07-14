use crate::models::note::{Note, NoteInput};
use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

fn note_from_row(row: sqlx::postgres::PgRow) -> Note {
    Note {
        id: row.get("id"),
        // In E2EE mode these columns hold WAYVE_SECURE_V1 envelope strings, so
        // they are passed through verbatim for client-side decryption.
        title: row.try_get("title").ok(),
        content: row.try_get("content").ok(),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
    }
}

#[get("/notes")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_notes(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // The RLS policy already enforces `user_id = app.user_id`; the explicit
    // WHERE is defense-in-depth and keeps the query plan unchanged.
    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(
            "SELECT id, title, content, created_at, updated_at
             FROM notes
             WHERE user_id = $1
             ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
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

    let title = data.title.as_deref().unwrap_or("Untitled");
    let content = data.content.as_deref().unwrap_or("");

    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let row = sqlx::query(
            "INSERT INTO notes (user_id, title, content)
             VALUES ($1, $2, $3)
             RETURNING id, title, content, created_at, updated_at",
        )
        .bind(user_id)
        .bind(title)
        .bind(content)
        .fetch_one(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await?;

    let note_id: i32 = row.get("id");
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "note_created",
            resource_type: "note",
            resource_id: Some(note_id.to_string()),
            metadata: Some(serde_json::json!({
                "name": title,
                "size": content.len() as i64,
            })),
        },
    )
    .await;

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

    // The owner-scoped UPDATE no-ops on someone else's note, so this 404s
    // rather than leaking that the id exists. The prior title is captured in
    // the same RLS transaction to tell a rename from a content edit.
    let title = data.title.as_deref().unwrap_or("Untitled");
    let content = data.content.as_deref().unwrap_or("");

    let (old_title, row) =
        crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
            let old_title: Option<String> =
                sqlx::query_scalar("SELECT title FROM notes WHERE id = $1 AND user_id = $2")
                    .bind(id)
                    .bind(user_id)
                    .fetch_optional(&mut *tx)
                    .await?;

            let row = sqlx::query(
                "UPDATE notes
             SET title = $1, content = $2, updated_at = NOW()
             WHERE id = $3 AND user_id = $4
             RETURNING id, title, content, created_at, updated_at",
            )
            .bind(title)
            .bind(content)
            .bind(id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound("note"))?;
            Ok((tx, (old_title, row)))
        })
        .await?;

    let renamed = old_title.as_deref() != Some(title);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: if renamed {
                "note_renamed"
            } else {
                "note_updated"
            },
            resource_type: "note",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({
                "name": title,
                "old_name": old_title,
                "size": content.len() as i64,
            })),
        },
    )
    .await;

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

    let removed = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let removed = sqlx::query(
            "DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING title, content",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        Ok((tx, removed))
    })
    .await?;

    let Some(row) = removed else {
        return Err(AppError::NotFound("note"));
    };
    let title: Option<String> = row.try_get("title").ok();
    let content: Option<String> = row.try_get("content").ok();
    let size = content.as_deref().map(|c| c.len() as i64).unwrap_or(0);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "note_deleted",
            resource_type: "note",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "name": title, "size": size })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
