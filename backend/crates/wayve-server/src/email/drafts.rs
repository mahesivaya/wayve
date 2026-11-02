//! Half-written emails, saved as the user types. These live only in Fluxze: the
//! Drafts folder's other rows are synced read-only from Gmail/Outlook.
//!
//! The recipients, subject and body are sealed together as one JSON blob, so the
//! table holds no readable mail. A reply or forward has one draft per source email
//! per user, which makes saving an upsert: a second tab joins the same draft
//! instead of creating a rival copy. Saves are too frequent to audit, and nothing
//! here logs the content.
use crate::prelude::*;
use actix_web::{delete, put};
use chrono::{DateTime, Utc};
use sqlx::Row;
use tracing::{instrument, warn};
use wayve_security::encryption;
use wayve_security::jwt::get_user_id_from_request;

/// Far above any real email's text, well under the app-wide JSON limit.
const MAX_CONTENT_BYTES: usize = 1024 * 1024;
/// Autosave creates rows without the user asking, so cap them per user.
const MAX_DRAFTS_PER_USER: i64 = 500;

const DRAFT_COLUMNS: &str =
    "id, kind, source_email_id, account_id, content_iv, content_encrypted, created_at, updated_at";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DraftContent {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDraft {
    pub kind: String,
    pub source_email_id: Option<i32>,
    pub account_id: Option<i32>,
    #[serde(flatten)]
    pub content: DraftContent,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDraft {
    pub account_id: Option<i32>,
    #[serde(flatten)]
    pub content: DraftContent,
}

fn seal(content: &DraftContent) -> Result<(String, String), AppError> {
    let plain =
        serde_json::to_string(content).map_err(|err| AppError::Internal(err.to_string()))?;
    if plain.len() > MAX_CONTENT_BYTES {
        return Err(AppError::BadRequest("Draft is too large to save".into()));
    }
    encryption::encrypt(&plain).map_err(|err| AppError::Internal(err.to_string()))
}

/// The row as the API returns it, or `None` when it can't be opened.
fn open_row(row: &sqlx::postgres::PgRow) -> Option<serde_json::Value> {
    let id: i32 = row.get("id");
    let iv: String = row.get("content_iv");
    let sealed: String = row.get("content_encrypted");
    let content = encryption::decrypt(&iv, &sealed)
        .map_err(|err| err.to_string())
        .and_then(|plain| {
            serde_json::from_str::<DraftContent>(&plain).map_err(|err| err.to_string())
        });
    let content = match content {
        Ok(content) => content,
        Err(error) => {
            warn!(target: "gmail", draft_id = id, error = %error, "email draft could not be opened");
            return None;
        }
    };
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");
    Some(serde_json::json!({
        "id": id,
        "kind": row.get::<String, _>("kind"),
        "source_email_id": row.get::<Option<i32>, _>("source_email_id"),
        "account_id": row.get::<Option<i32>, _>("account_id"),
        "to": content.to,
        "cc": content.cc,
        "bcc": content.bcc,
        "subject": content.subject,
        "body": content.body,
        "created_at": created_at,
        "updated_at": updated_at,
    }))
}

fn saved_response(row: &sqlx::postgres::PgRow) -> AppResult {
    let draft =
        open_row(row).ok_or_else(|| AppError::Internal("draft could not be opened".into()))?;
    Ok(HttpResponse::Ok().json(draft))
}

/// A draft may only name a mailbox the user owns or shares, the same two ways the
/// send path accepts one. Answers 404 either way, so an id's existence can't leak.
async fn require_account(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    account_id: Option<i32>,
    user_id: i32,
) -> Result<(), AppError> {
    let Some(account_id) = account_id else {
        return Ok(());
    };
    let visible: bool = sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM email_accounts a
              WHERE a.id = $1
                AND (a.user_id = $2 OR EXISTS (
                     SELECT 1 FROM shared_inbox_members m
                      WHERE m.account_id = a.id AND m.user_id = $2)))",
    )
    .bind(account_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    if visible {
        Ok(())
    } else {
        Err(AppError::NotFound("account"))
    }
}

#[get("/email/drafts")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_drafts(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let sql = format!(
        "SELECT {DRAFT_COLUMNS} FROM email_drafts
          WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2"
    );
    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(&sql)
            .bind(user_id)
            .bind(MAX_DRAFTS_PER_USER)
            .fetch_all(&mut *tx)
            .await?;
        Ok((tx, rows))
    })
    .await?;
    Ok(HttpResponse::Ok().json(rows.iter().filter_map(open_row).collect::<Vec<_>>()))
}

#[post("/email/drafts")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_draft(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateDraft>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let CreateDraft {
        kind,
        source_email_id,
        account_id,
        content,
    } = data.into_inner();

    match (kind.as_str(), source_email_id) {
        ("compose", None) | ("reply", Some(_)) | ("forward", Some(_)) => {}
        ("compose", Some(_)) => {
            return Err(AppError::BadRequest(
                "A new email has no source email".into(),
            ));
        }
        ("reply" | "forward", None) => {
            return Err(AppError::BadRequest(
                "A reply or forward needs its source email".into(),
            ));
        }
        _ => return Err(AppError::BadRequest("Unknown draft kind".into())),
    }
    if let Some(source) = source_email_id
        && crate::email::repo::get_detail(pool.get_ref(), source, user_id)
            .await?
            .is_none()
    {
        return Err(AppError::NotFound("email"));
    }
    let (iv, sealed) = seal(&content)?;

    let sql = format!(
        "INSERT INTO email_drafts
             (user_id, kind, source_email_id, account_id, content_iv, content_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, source_email_id) DO UPDATE
            SET account_id = EXCLUDED.account_id,
                content_iv = EXCLUDED.content_iv,
                content_encrypted = EXCLUDED.content_encrypted,
                updated_at = NOW()
         RETURNING {DRAFT_COLUMNS}"
    );
    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        require_account(&mut tx, account_id, user_id).await?;
        let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_drafts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
        if held >= MAX_DRAFTS_PER_USER {
            return Err(AppError::BadRequest(
                "Too many drafts. Delete some to save more.".into(),
            ));
        }
        let row = sqlx::query(&sql)
            .bind(user_id)
            .bind(&kind)
            .bind(source_email_id)
            .bind(account_id)
            .bind(&iv)
            .bind(&sealed)
            .fetch_one(&mut *tx)
            .await?;
        Ok((tx, row))
    })
    .await?;
    saved_response(&row)
}

#[put("/email/drafts/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_draft(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<UpdateDraft>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let UpdateDraft {
        account_id,
        content,
    } = data.into_inner();
    let (iv, sealed) = seal(&content)?;

    let sql = format!(
        "UPDATE email_drafts
            SET account_id = $1, content_iv = $2, content_encrypted = $3, updated_at = NOW()
          WHERE id = $4 AND user_id = $5
         RETURNING {DRAFT_COLUMNS}"
    );
    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        require_account(&mut tx, account_id, user_id).await?;
        let row = sqlx::query(&sql)
            .bind(account_id)
            .bind(&iv)
            .bind(&sealed)
            .bind(id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound("draft"))?;
        Ok((tx, row))
    })
    .await?;
    saved_response(&row)
}

/// Idempotent, and the same answer for someone else's id: discarding twice, or
/// from a second tab, isn't an error.
#[delete("/email/drafts/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_draft(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        sqlx::query("DELETE FROM email_drafts WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        Ok((tx, ()))
    })
    .await?;
    Ok(HttpResponse::NoContent().finish())
}
