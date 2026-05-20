use crate::cache::Cache;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::outlook::{OutlookAttachmentRef, download_outlook_attachment};
use crate::email::provider::{MailProvider, MailProviderClients, refresh_and_persist_email_token};
use crate::email::sync_older::sync_older_page;
use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;

use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, delete, get, web};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sqlx::{PgPool, QueryBuilder, Row};
use tracing::{error, info, instrument, warn};

#[derive(Deserialize)]
pub struct EmailQuery {
    pub account_id: Option<i32>,
    pub before: Option<i64>,
    pub before_id: Option<i32>,
    pub folder: Option<String>,
    pub q: Option<String>,
}

#[derive(Deserialize)]
pub struct EmailAttachmentPath {
    pub id: i32,
}

#[derive(Deserialize)]
pub struct EmailDeletePath {
    pub id: i32,
}

#[derive(Deserialize)]
pub struct EmailAttachmentDownloadPath {
    pub id: i32,
}

#[get("/emails")]
#[instrument(target = "http", skip(req, pool, _cache, query))]
pub async fn get_emails(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    _cache: web::Data<Option<Cache>>,
    query: web::Query<EmailQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let page_size = 50;
    let query_limit = page_size + 1;

    if let Some(before) = query.before
        && let Err(e) = sync_older_page(
            pool.get_ref(),
            user_id,
            query.account_id,
            before,
            query_limit,
        )
        .await
    {
        warn!(target: "gmail", user_id, error = ?e, "older email page sync failed");
    }

    // 🔥 Build query dynamically
    let mut qb = QueryBuilder::new(
        r#"
        SELECT e.id, e.gmail_id, e.subject, e.sender, e.receiver,
               (e.body_encrypted <> '') AS has_body,
               EXISTS (
                   SELECT 1 FROM email_attachments ea WHERE ea.email_id = e.id
               ) AS has_attachments,
               e.account_id, e.is_read, e.created_at
        FROM emails e
        JOIN email_accounts a ON e.account_id = a.id
        WHERE a.user_id =
        "#,
    );

    qb.push_bind(user_id);

    // ✅ Optional account filter
    if let Some(account_id) = query.account_id {
        qb.push(" AND a.id = ");
        qb.push_bind(account_id);
    }

    // ✅ Folder filter (FIX)
    if let Some(folder) = &query.folder {
        match folder.as_str() {
            "inbox" => {
                qb.push(
                    " AND lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%' ",
                );
            }
            "sent" => {
                qb.push(" AND lower(coalesce(e.sender, '')) LIKE '%' || lower(a.email) || '%' ");
            }
            _ => {}
        }
    }

    if let Some(search) = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pattern = format!("%{}%", search.to_lowercase());
        qb.push(
            r#"
            AND (
                lower(coalesce(e.subject, '')) LIKE
            "#,
        );
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.sender, '')) LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.receiver, '')) LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.gmail_id, '')) LIKE ");
        qb.push_bind(pattern);
        qb.push(") ");
    }

    // ✅ Pagination filter
    if let (Some(before), Some(before_id)) = (query.before, query.before_id) {
        qb.push(" AND (e.created_at, e.id) < (to_timestamp(");
        qb.push_bind(before);
        qb.push("), ");
        qb.push_bind(before_id);
        qb.push(")");
    }

    // ✅ Order + limit
    qb.push(" ORDER BY e.created_at DESC, e.id DESC LIMIT ");
    qb.push_bind(query_limit as i64);

    let rows = qb.build().fetch_all(pool.get_ref()).await?;

    let has_more = rows.len() > page_size;
    let emails: Vec<Value> = rows
        .into_iter()
        .take(page_size)
        .map(|row| {
            let created_at: Option<NaiveDateTime> = row.get("created_at");
            let created_at = created_at.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });

            serde_json::json!({
                "id": row.get::<i32,_>("id"),
                "gmail_id": row.get::<String,_>("gmail_id"),
                "subject": row.get::<Option<String>,_>("subject"),
                "sender": row.get::<Option<String>,_>("sender"),
                "receiver": row.get::<Option<String>,_>("receiver"),
                "has_body": row.get::<bool,_>("has_body"),
                "has_attachments": row.get::<bool,_>("has_attachments"),
                "account_id": row.get::<Option<i32>,_>("account_id"),
                "is_read": row.get::<Option<bool>,_>("is_read").unwrap_or(true),
                "created_at": created_at,
            })
        })
        .collect();

    info!(target: "http", user_id, count = emails.len(), "Fetched emails");
    Ok(HttpResponse::Ok()
        .append_header(("x-has-more", has_more.to_string()))
        .json(emails))
}

#[delete("/emails/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let email_id = path.id;
    let row = match sqlx::query(
        r#"
        SELECT e.gmail_id, a.id AS account_id, a.refresh_token, a.provider
        FROM emails e
        JOIN email_accounts a ON e.account_id = a.id
        WHERE e.id = $1 AND a.user_id = $2
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    {
        Some(row) => row,
        None => {
            return Ok(HttpResponse::NotFound().json(serde_json::json!({
                "error": "Email not found"
            })));
        }
    };

    let gmail_id: String = row.get("gmail_id");
    let account_id: i32 = row.get("account_id");
    let provider = row
        .try_get::<String, _>("provider")
        .map(|value| MailProvider::from_db(&value))
        .unwrap_or(MailProvider::Google);
    let refresh_token: Option<String> = row.get("refresh_token");

    let Some(refresh_token) = refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(HttpResponse::Unauthorized().json(serde_json::json!({
            "error": "Reconnect your email account to delete this email"
        })));
    };

    let token = match refresh_and_persist_email_token(
        pool.get_ref(),
        account_id,
        provider,
        refresh_token,
        MailProviderClients::for_provider(provider),
    )
    .await
    {
        Ok(token) => token.access_token,
        Err(e) => {
            error!(target: "gmail", user_id, account_id, provider = provider.as_db(), error = ?e, "delete email token refresh failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Failed to refresh email account credentials"
            })));
        }
    };

    let remote_delete = if provider.is_microsoft() {
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1.0/me/messages",
            crate::external::microsoft_graph_base()
        ))
        .unwrap_or_else(|e| panic!("valid Graph URL: {e}"));
        url.path_segments_mut()
            .unwrap_or_else(|_| panic!("Graph base must be a base URL"))
            .push(&gmail_id);
        HTTP_CLIENT.delete(url).bearer_auth(&token).send().await
    } else {
        let url = format!(
            "{}/gmail/v1/users/me/messages/{}",
            crate::external::gmail_api_base(),
            gmail_id
        );
        HTTP_CLIENT.delete(url).bearer_auth(&token).send().await
    };

    match remote_delete {
        Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 404 => {}
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            error!(target: "gmail", user_id, account_id, provider = provider.as_db(), email_id, %status, body = %body, "remote email delete failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Email provider rejected the delete request"
            })));
        }
        Err(e) => {
            error!(target: "gmail", user_id, account_id, provider = provider.as_db(), email_id, error = ?e, "remote email delete request failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Failed to reach email provider"
            })));
        }
    }

    sqlx::query("DELETE FROM emails WHERE id = $1")
        .bind(email_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

#[get("/emails/attachments")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_all_email_attachments(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        r#"
        SELECT ea.id, ea.email_id, ea.filename, ea.mime_type, ea.size,
               ea.created_at, e.subject, e.sender, e.receiver
        FROM email_attachments ea
        JOIN emails e ON ea.email_id = e.id
        JOIN email_accounts a ON ea.account_id = a.id
        WHERE a.user_id = $1
        ORDER BY ea.created_at DESC, ea.id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let files: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let created_at: Option<NaiveDateTime> = row.get("created_at");
            let created_at = created_at.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });

            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "email_id": row.get::<i32, _>("email_id"),
                "filename": row.get::<String, _>("filename"),
                "mime_type": row.get::<Option<String>, _>("mime_type"),
                "size": row.get::<Option<i64>, _>("size"),
                "created_at": created_at,
                "subject": row.get::<Option<String>, _>("subject"),
                "sender": row.get::<Option<String>, _>("sender"),
                "receiver": row.get::<Option<String>, _>("receiver"),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(files))
}

// Mark an email as read for the authenticated user. The frontend already
// flips `is_read` optimistically when the user opens an email, but without
// this endpoint the change isn't persisted — refreshing the inbox showed
// the row as unread again. We update Wayve's own `emails.is_read`; pushing
// the state to Gmail/Outlook so the user's other clients reflect it is a
// follow-up (needs OAuth token refresh + provider API call per row).
#[actix_web::post("/emails/{id}/read")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn mark_email_read(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.id;

    // Tenant boundary: a user may only mark their *own* emails read. The join
    // through email_accounts.user_id is the authorization gate.
    let result = sqlx::query(
        r#"
        UPDATE emails AS e
           SET is_read = TRUE
          FROM email_accounts AS a
         WHERE e.account_id = a.id
           AND e.id = $1
           AND a.user_id = $2
           AND e.is_read = FALSE
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;

    // rows_affected == 0 covers two cases that we don't distinguish here:
    //   - email doesn't exist / isn't owned by this user (treat as 404)
    //   - email was already marked read (treat as no-op success)
    // We can't tell them apart without a second query, so probe ownership.
    if result.rows_affected() == 0 {
        let owns: Option<i32> = sqlx::query_scalar(
            "SELECT e.id FROM emails e JOIN email_accounts a ON e.account_id = a.id \
             WHERE e.id = $1 AND a.user_id = $2",
        )
        .bind(email_id)
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?;
        if owns.is_none() {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "error": "Email not found" }))
            );
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "is_read": true })))
}

#[get("/emails/{id}/attachments")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_email_attachments(
    req: HttpRequest,
    path: web::Path<EmailAttachmentPath>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let email_id = path.id;

    let rows = sqlx::query(
        r#"
        SELECT ea.id, ea.email_id, ea.filename, ea.mime_type, ea.size, ea.created_at
        FROM email_attachments ea
        JOIN email_accounts a ON ea.account_id = a.id
        WHERE ea.email_id = $1 AND a.user_id = $2
        ORDER BY ea.id ASC
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let files: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let created_at: Option<NaiveDateTime> = row.get("created_at");
            let created_at = created_at.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });

            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "email_id": row.get::<i32, _>("email_id"),
                "filename": row.get::<String, _>("filename"),
                "mime_type": row.get::<Option<String>, _>("mime_type"),
                "size": row.get::<Option<i64>, _>("size"),
                "created_at": created_at,
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(files))
}

#[get("/email-attachments/{id}/download")]
#[instrument(target = "gmail", skip(req, pool, path))]
pub async fn download_email_attachment(
    req: HttpRequest,
    path: web::Path<EmailAttachmentDownloadPath>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let row = match sqlx::query(
        r#"
        SELECT ea.attachment_id, ea.gmail_id, ea.filename, ea.mime_type,
               a.id AS account_id, a.refresh_token, a.provider
        FROM email_attachments ea
        JOIN email_accounts a ON ea.account_id = a.id
        WHERE ea.id = $1 AND a.user_id = $2
        "#,
    )
    .bind(path.id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    {
        Some(row) => row,
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    let account_id: i32 = row.get("account_id");
    let refresh_token: Option<String> = row.get("refresh_token");
    let refresh_token = match refresh_token.filter(|value| !value.trim().is_empty()) {
        Some(value) => value,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "Reconnect your email account to download this attachment"
            })));
        }
    };

    let provider = row
        .try_get("provider")
        .map(|value: String| MailProvider::from_db(&value))
        .unwrap_or(MailProvider::Google);
    let gmail_id: String = row.get("gmail_id");
    let gmail_attachment_id: String = row.get("attachment_id");
    let filename: String = row.get("filename");
    let mime_type: Option<String> = row.get("mime_type");

    let token = match refresh_and_persist_email_token(
        pool.get_ref(),
        account_id,
        provider,
        &refresh_token,
        MailProviderClients::for_provider(provider),
    )
    .await
    {
        Ok(token) => token,
        Err(e) => {
            error!(target: "gmail", account_id, provider = provider.as_db(), error = ?e, "attachment token refresh failed");
            if e.to_string().contains("not configured") {
                return Ok(HttpResponse::InternalServerError().finish());
            }
            return Ok(HttpResponse::BadGateway().finish());
        }
    };

    // Outlook attachments come from Microsoft Graph; Gmail continues below.
    if provider.is_microsoft() {
        return Ok(download_outlook_attachment(
            &token.access_token,
            OutlookAttachmentRef {
                message_id: &gmail_id,
                attachment_id: &gmail_attachment_id,
                filename: &filename,
                mime_type,
            },
        )
        .await);
    }

    let url = format!(
        "{}/gmail/v1/users/me/messages/{}/attachments/{}",
        crate::external::gmail_api_base(),
        gmail_id,
        gmail_attachment_id
    );

    let res: Value = match HTTP_CLIENT
        .get(&url)
        .bearer_auth(&token.access_token)
        .send()
        .await
    {
        Ok(resp) => match resp.json().await {
            Ok(json) => json,
            Err(e) => {
                error!(target: "gmail", error = %e, "attachment json parse failed");
                return Ok(HttpResponse::BadGateway().finish());
            }
        },
        Err(e) => {
            error!(target: "gmail", error = %e, "attachment request failed");
            return Ok(HttpResponse::BadGateway().finish());
        }
    };

    let data = res["data"].as_str().unwrap_or("");
    let bytes = match URL_SAFE_NO_PAD.decode(data) {
        Ok(bytes) => bytes,
        Err(e) => {
            error!(target: "gmail", error = ?e, "attachment base64 decode failed");
            return Ok(HttpResponse::BadGateway().finish());
        }
    };

    Ok(HttpResponse::Ok()
        .insert_header((
            header::CONTENT_TYPE,
            mime_type.unwrap_or_else(|| "application/octet-stream".to_string()),
        ))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "")),
        ))
        .body(bytes))
}
