// In-app support tickets.
//
// Any authenticated user (personal, organization, platform) can raise a
// ticket from the "Help & Report issue" entry point in the header profile
// menu or the Support section on /settings. Tickets land in
// `support_tickets`; staff with `tickets:manage` (the `support` role in
// rbac.rs, plus owner/super_admin) read & resolve them via the admin
// endpoints. Replies are sent off-band by email to the ticket owner — we
// intentionally don't model an in-app reply thread here (smaller surface,
// faster to ship, matches the scope agreed with the user).

use crate::prelude::*;
use actix_multipart::Multipart;
use actix_web::{Error, delete, http::header, patch};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use tokio::{fs, io::AsyncWriteExt};
use tracing::{error, info, instrument};
use uuid::Uuid;
use wayve_security::encryption::{decrypt_binary, encrypt_binary};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission};

const ALLOWED_CATEGORIES: &[&str] = &["bug", "feature", "billing", "account", "other"];
const ALLOWED_STATUSES: &[&str] = &["open", "in_progress", "resolved", "closed"];

#[derive(Serialize, FromRow)]
pub struct SupportTicketView {
    pub id: i32,
    pub user_id: i32,
    pub user_email: Option<String>,
    pub organization_id: Option<i32>,
    pub organization_name: Option<String>,
    pub subject: String,
    pub description: String,
    pub category: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub attachment_count: i64,
}

#[derive(Serialize, FromRow)]
pub struct SupportAttachmentView {
    pub id: i64,
    pub ticket_id: i32,
    pub name: String,
    pub file_type: Option<String>,
    pub size: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct CreateTicketBody {
    pub subject: String,
    pub description: String,
    pub category: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateTicketBody {
    pub status: String,
}

fn validate_category(value: &str) -> Result<&str, AppError> {
    if ALLOWED_CATEGORIES.contains(&value) {
        Ok(value)
    } else {
        Err(AppError::BadRequest(format!("invalid category '{value}'")))
    }
}

fn validate_status(value: &str) -> Result<&str, AppError> {
    if ALLOWED_STATUSES.contains(&value) {
        Ok(value)
    } else {
        Err(AppError::BadRequest(format!("invalid status '{value}'")))
    }
}

#[post("/support/tickets")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<CreateTicketBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let subject = body.subject.trim();
    let description = body.description.trim();
    if subject.is_empty() || description.is_empty() {
        return Err(AppError::BadRequest(
            "subject and description are required".into(),
        ));
    }
    let category = match body.category.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => validate_category(v)?.to_string(),
        _ => "other".to_string(),
    };

    // Carry the user's current organization onto the ticket so platform
    // staff can group/filter by tenant later without an extra join.
    let org_id: Option<i32> = sqlx::query_scalar("SELECT organization_id FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(pool.get_ref())
        .await?;

    let id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO support_tickets (user_id, organization_id, subject, description, category)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(org_id)
    .bind(subject)
    .bind(description)
    .bind(&category)
    .fetch_one(pool.get_ref())
    .await?;

    info!(
        target: "http",
        user_id, ticket_id = id, category = %category,
        "support ticket created"
    );

    Ok(HttpResponse::Created().json(serde_json::json!({ "id": id })))
}

#[get("/support/tickets")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_my_tickets(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query_as::<_, SupportTicketView>(
        r#"
        SELECT t.id, t.user_id,
               u.email AS user_email,
               t.organization_id,
               o.name  AS organization_name,
               t.subject, t.description, t.category, t.status,
               t.created_at, t.updated_at, t.resolved_at,
               COALESCE((
                   SELECT COUNT(*) FROM support_ticket_attachments a
                   WHERE a.ticket_id = t.id
               ), 0) AS attachment_count
        FROM support_tickets t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN organizations o ON o.id = t.organization_id
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC
        LIMIT 100
        "#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

async fn user_owns_ticket(pool: &PgPool, ticket_id: i32, user_id: i32) -> sqlx::Result<bool> {
    let id: Option<i32> =
        sqlx::query_scalar("SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2")
            .bind(ticket_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(id.is_some())
}

// Either the ticket owner OR a staff member with TicketsManage may read/write
// the ticket. Returns `(is_admin, ticket_user_id)` on success.
async fn authorize_ticket(
    req: &HttpRequest,
    pool: &PgPool,
    ticket_id: i32,
) -> Result<(bool, i32), AppError> {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;

    let owner_id: Option<i32> =
        sqlx::query_scalar("SELECT user_id FROM support_tickets WHERE id = $1")
            .bind(ticket_id)
            .fetch_optional(pool)
            .await?;
    let owner_id = owner_id.ok_or(AppError::NotFound("ticket"))?;

    if owner_id == user_id {
        return Ok((false, owner_id));
    }

    // Not the owner — must hold tickets:manage to proceed.
    let ctx = rbac::resolve_role_context(pool, user_id)
        .await
        .map_err(|_| AppError::Forbidden)?;
    if ctx.has(Permission::TicketsManage) {
        Ok((true, owner_id))
    } else {
        Err(AppError::Forbidden)
    }
}

#[get("/support/tickets/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ticket_id = path.into_inner();
    authorize_ticket(&req, pool.get_ref(), ticket_id).await?;

    let row = sqlx::query_as::<_, SupportTicketView>(
        r#"
        SELECT t.id, t.user_id,
               u.email AS user_email,
               t.organization_id,
               o.name  AS organization_name,
               t.subject, t.description, t.category, t.status,
               t.created_at, t.updated_at, t.resolved_at,
               COALESCE((
                   SELECT COUNT(*) FROM support_ticket_attachments a
                   WHERE a.ticket_id = t.id
               ), 0) AS attachment_count
        FROM support_tickets t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN organizations o ON o.id = t.organization_id
        WHERE t.id = $1
        "#,
    )
    .bind(ticket_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("ticket"))?;

    Ok(HttpResponse::Ok().json(row))
}

#[get("/support/admin/tickets")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn admin_list_tickets(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AdminListQuery>,
) -> AppResult {
    let _ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let status_filter = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(s) = status_filter {
        validate_status(s)?;
    }

    let rows = sqlx::query_as::<_, SupportTicketView>(
        r#"
        SELECT t.id, t.user_id,
               u.email AS user_email,
               t.organization_id,
               o.name  AS organization_name,
               t.subject, t.description, t.category, t.status,
               t.created_at, t.updated_at, t.resolved_at,
               COALESCE((
                   SELECT COUNT(*) FROM support_ticket_attachments a
                   WHERE a.ticket_id = t.id
               ), 0) AS attachment_count
        FROM support_tickets t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN organizations o ON o.id = t.organization_id
        WHERE ($1::TEXT IS NULL OR t.status = $1)
        ORDER BY
            CASE t.status
                WHEN 'open' THEN 0
                WHEN 'in_progress' THEN 1
                WHEN 'resolved' THEN 2
                WHEN 'closed' THEN 3
                ELSE 4
            END,
            t.created_at DESC
        LIMIT 500
        "#,
    )
    .bind(status_filter)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[derive(Deserialize)]
pub struct AdminListQuery {
    pub status: Option<String>,
}

#[patch("/support/admin/tickets/{id}")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn admin_update_ticket(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<UpdateTicketBody>,
) -> AppResult {
    let _ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let ticket_id = path.into_inner();
    let status = validate_status(body.status.trim())?.to_string();
    let now_resolved = matches!(status.as_str(), "resolved" | "closed");

    let updated: Option<i32> = sqlx::query_scalar(
        r#"
        UPDATE support_tickets
        SET status = $2,
            updated_at = NOW(),
            resolved_at = CASE
                WHEN $3 AND resolved_at IS NULL THEN NOW()
                WHEN NOT $3 THEN NULL
                ELSE resolved_at
            END
        WHERE id = $1
        RETURNING id
        "#,
    )
    .bind(ticket_id)
    .bind(&status)
    .bind(now_resolved)
    .fetch_optional(pool.get_ref())
    .await?;

    updated.ok_or(AppError::NotFound("ticket"))?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": ticket_id,
        "status": status,
    })))
}

// ── Attachments ──────────────────────────────────────────────────────
// Mirrors `tasks/attachments.rs`. AES-GCM encrypts the file body on the
// way in and base64-stores the nonce alongside the row.

#[post("/support/tickets/{id}/attachments")]
#[instrument(target = "http", skip(req, payload, pool, path))]
pub async fn upload_ticket_attachments(
    req: HttpRequest,
    mut payload: Multipart,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> Result<HttpResponse, Error> {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };
    let ticket_id = path.into_inner();

    let owns = user_owns_ticket(pool.get_ref(), ticket_id, user_id)
        .await
        .map_err(|e| {
            error!(target: "http", error = ?e, "ticket ownership check failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;
    if !owns {
        return Ok(HttpResponse::NotFound().finish());
    }

    let upload_dir = "./uploads";
    fs::create_dir_all(upload_dir).await.map_err(|e| {
        error!(target: "http", error = ?e, "upload dir create failed");
        actix_web::error::ErrorInternalServerError("Dir error")
    })?;

    let mut saved: Vec<SupportAttachmentView> = Vec::new();

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

        let file_id = Uuid::new_v4().to_string();
        let filepath = format!(
            "{}/support_{}_{}_{}",
            upload_dir, ticket_id, file_id, filename
        );

        let mut size: i64 = 0;
        let mut plaintext: Vec<u8> = Vec::new();
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|_| actix_web::error::ErrorBadRequest("Chunk error"))?;
            size += data.len() as i64;
            plaintext.extend_from_slice(&data);
        }

        let (file_iv, encrypted_bytes) = encrypt_binary(&plaintext).map_err(|e| {
            error!(target: "http", error = %e, "support attachment encrypt failed");
            actix_web::error::ErrorInternalServerError("File encrypt error")
        })?;

        let mut f = fs::File::create(&filepath).await.map_err(|e| {
            error!(target: "http", path = %filepath, error = ?e, "support attachment create failed");
            actix_web::error::ErrorInternalServerError("File create error")
        })?;
        f.write_all(&encrypted_bytes).await.map_err(|e| {
            error!(target: "http", path = %filepath, error = ?e, "support attachment write failed");
            actix_web::error::ErrorInternalServerError("Write error")
        })?;

        let file_type = filename.rsplit('.').next().unwrap_or("").to_string();

        let row: SupportAttachmentView = sqlx::query_as::<_, SupportAttachmentView>(
            r#"
            INSERT INTO support_ticket_attachments (ticket_id, user_id, name, file_type, file_path, file_iv, size)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, ticket_id, name, file_type, size, created_at
            "#,
        )
        .bind(ticket_id)
        .bind(user_id)
        .bind(&filename)
        .bind(&file_type)
        .bind(&filepath)
        .bind(&file_iv)
        .bind(size)
        .fetch_one(pool.get_ref())
        .await
        .map_err(|e| {
            error!(target: "http", user_id, ticket_id, error = ?e, "support attachment insert failed");
            actix_web::error::ErrorInternalServerError("DB error")
        })?;

        info!(
            target: "http",
            "Support attachment saved: ticket_id={} name=\"{}\" size={}",
            ticket_id, filename, size
        );
        saved.push(row);
    }

    Ok(HttpResponse::Ok().json(saved))
}

#[get("/support/tickets/{id}/attachments")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn list_ticket_attachments(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ticket_id = path.into_inner();
    authorize_ticket(&req, pool.get_ref(), ticket_id).await?;

    let rows = sqlx::query_as::<_, SupportAttachmentView>(
        r#"
        SELECT id, ticket_id, name, file_type, size, created_at
        FROM support_ticket_attachments
        WHERE ticket_id = $1
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(ticket_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[get("/support-attachments/{id}/download")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn download_ticket_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "SELECT ticket_id, name, file_path, file_iv
         FROM support_ticket_attachments
         WHERE id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound("attachment"));
    };

    let ticket_id: i32 = row.get("ticket_id");
    authorize_ticket(&req, pool.get_ref(), ticket_id).await?;

    let name: String = row.get("name");
    let file_path: String = row.get("file_path");
    let file_iv: Option<String> = row.try_get("file_iv").ok();

    match fs::read(&file_path).await {
        Ok(bytes) => {
            let body = match file_iv.as_deref().filter(|v| !v.is_empty()) {
                Some(iv) => decrypt_binary(iv, &bytes).map_err(|e| {
                    AppError::Internal(format!("support attachment decrypt failed: {e}"))
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
            error!(target: "http", attachment_id, error = ?e, "support attachment open failed");
            Err(AppError::NotFound("attachment"))
        }
    }
}

#[delete("/support-attachments/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_ticket_attachment(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i64>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let attachment_id = path.into_inner();

    let row = sqlx::query(
        "DELETE FROM support_ticket_attachments
         WHERE id = $1 AND user_id = $2
         RETURNING file_path",
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound("attachment"));
    };
    let file_path: String = row.get("file_path");
    if let Err(e) = fs::remove_file(&file_path).await {
        error!(target: "http", user_id, attachment_id, error = ?e, "support attachment blob remove failed");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
