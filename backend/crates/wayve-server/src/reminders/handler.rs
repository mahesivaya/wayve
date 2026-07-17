use crate::models::reminder::{Reminder, ReminderInput};
use crate::prelude::*;
use actix_web::delete;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

fn reminder_from_row(row: sqlx::postgres::PgRow) -> Reminder {
    Reminder {
        id: row.get("id"),
        title: row.try_get("title").unwrap_or_default(),
        notes: row.try_get("notes").ok(),
        remind_at: row.get("remind_at"),
        created_at: row.try_get("created_at").ok(),
    }
}

// Accepts "YYYY-MM-DDTHH:MM" (from an <input type="datetime-local">) or with
// seconds. Parsed as naive local wall-clock time, matching meeting storage.
fn parse_remind_at(raw: &str) -> Result<NaiveDateTime, AppError> {
    let s = raw.trim();
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .map_err(|_| AppError::bad_request("remind_at must be YYYY-MM-DDTHH:MM"))
}

#[get("/reminders")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_reminders(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // RLS already scopes to the owner; the explicit WHERE is defense-in-depth.
    // Nearest first so the client renders them in reminder order.
    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(
            "SELECT id, title, notes, remind_at, created_at
             FROM reminders
             WHERE user_id = $1
             ORDER BY remind_at ASC",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(reminder_from_row).collect::<Vec<_>>()))
}

#[post("/reminders")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_reminder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ReminderInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let title = data.title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("title is required"));
    }
    let remind_at = parse_remind_at(&data.remind_at)?;
    let notes = data
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());

    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let row = sqlx::query(
            "INSERT INTO reminders (user_id, title, notes, remind_at)
             VALUES ($1, $2, $3, $4)
             RETURNING id, title, notes, remind_at, created_at",
        )
        .bind(user_id)
        .bind(title)
        .bind(notes)
        .bind(remind_at)
        .fetch_one(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await?;

    let reminder_id: i32 = row.get("id");
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "reminder_created",
            resource_type: "reminder",
            resource_id: Some(reminder_id.to_string()),
            metadata: Some(serde_json::json!({ "title": title })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(reminder_from_row(row)))
}

#[delete("/reminders/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_reminder(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    // The owner-scoped DELETE no-ops on someone else's row, so a missing id
    // 404s rather than leaking existence.
    let removed = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let removed =
            sqlx::query("DELETE FROM reminders WHERE id = $1 AND user_id = $2 RETURNING id")
                .bind(id)
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await?;
        Ok((tx, removed))
    })
    .await?;

    if removed.is_none() {
        return Err(AppError::NotFound("reminder"));
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "reminder_deleted",
            resource_type: "reminder",
            resource_id: Some(id.to_string()),
            metadata: None,
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
