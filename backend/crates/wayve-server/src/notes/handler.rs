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

/// One page of the list holds this many notes unless the caller asks otherwise.
pub const DEFAULT_PAGE_SIZE: i64 = 50;
/// The most a caller can ask for in one page.
pub const MAX_PAGE_SIZE: i64 = 200;
/// Longer search text is cut to this many characters.
const MAX_QUERY_CHARS: usize = 200;

#[derive(Debug, Deserialize)]
pub struct ListNotesQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    /// `edited` (default), `created` or `name`.
    sort: Option<String>,
    /// `desc` (default) or `asc`.
    dir: Option<String>,
    /// Matches title or text, ignoring case.
    q: Option<String>,
}

/// A row of the list. Bodies can be megabytes each, so the list leaves them
/// out; `GET /notes/{id}` returns the whole note when it's opened.
#[derive(Serialize)]
struct NoteSummary {
    id: i32,
    title: Option<String>,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

/// The ORDER BY for a sort choice. Only these fixed strings reach the SQL, so
/// the query parameters can't inject anything. `id` breaks ties, so a page
/// boundary never falls between equal rows in a different order each time.
fn order_by(sort: Option<&str>, dir: Option<&str>) -> &'static str {
    let asc = dir == Some("asc");
    match (sort, asc) {
        (Some("name"), false) => {
            "lower(COALESCE(NULLIF(btrim(title), ''), 'Untitled')) DESC, id DESC"
        }
        (Some("name"), true) => "lower(COALESCE(NULLIF(btrim(title), ''), 'Untitled')) ASC, id ASC",
        (Some("created"), false) => "created_at DESC NULLS LAST, id DESC",
        (Some("created"), true) => "created_at ASC NULLS FIRST, id ASC",
        (_, true) => "updated_at ASC NULLS FIRST, id ASC",
        (_, false) => "updated_at DESC NULLS LAST, id DESC",
    }
}

/// `q` as an ILIKE pattern that matches it literally anywhere in the text.
fn contains_pattern(q: &str) -> String {
    let mut pattern = String::with_capacity(q.len() + 2);
    pattern.push('%');
    for ch in q.chars().take(MAX_QUERY_CHARS) {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

/// `GET /notes?limit=&offset=&sort=&dir=&q=`: one page of the caller's notes
/// as `{ notes, total, has_more }`, without their text. Notes written before
/// they were stored in the clear hold ciphertext, which search can't match.
#[get("/notes")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_notes(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ListNotesQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let query = query.into_inner();

    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0).max(0);
    let pattern = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(contains_pattern);
    // One row past the page tells whether another page follows.
    let sql = format!(
        "SELECT id, title, created_at, updated_at
         FROM notes
         WHERE user_id = $1
           AND ($2::text IS NULL OR title ILIKE $2 OR content ILIKE $2)
         ORDER BY {}
         LIMIT $3 OFFSET $4",
        order_by(query.sort.as_deref(), query.dir.as_deref())
    );

    // The RLS policy already enforces `user_id = app.user_id`; the explicit
    // WHERE is defense-in-depth and lets idx_notes_user_updated serve the
    // default order.
    let (rows, total) = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(&sql)
            .bind(user_id)
            .bind(pattern.as_deref())
            .bind(limit + 1)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notes
             WHERE user_id = $1
               AND ($2::text IS NULL OR title ILIKE $2 OR content ILIKE $2)",
        )
        .bind(user_id)
        .bind(pattern.as_deref())
        .fetch_one(&mut *tx)
        .await?;
        Ok((tx, (rows, total)))
    })
    .await?;

    let has_more = rows.len() as i64 > limit;
    let notes: Vec<NoteSummary> = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| NoteSummary {
            id: row.get("id"),
            title: row.try_get("title").ok(),
            created_at: row.try_get("created_at").ok(),
            updated_at: row.try_get("updated_at").ok(),
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "notes": notes,
        "total": total,
        "has_more": has_more,
    })))
}

/// `GET /notes/{id}`: one of the caller's notes with its text. Someone else's
/// note is "not found", the same as one that doesn't exist.
#[get("/notes/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_note(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let row = sqlx::query(
            "SELECT id, title, content, created_at, updated_at
             FROM notes
             WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await?
    .ok_or(AppError::NotFound("note"))?;

    Ok(HttpResponse::Ok().json(note_from_row(row)))
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
