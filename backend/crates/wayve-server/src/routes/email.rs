use crate::cache::Cache;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::outlook::{OutlookAttachmentRef, download_outlook_attachment};
use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
use crate::email::repo::{self, EmailListFilters};
use crate::email::sync_older::sync_older_page;
use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, delete, get, web};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sqlx::{PgPool, Row};
use tracing::{error, info, instrument, warn};

#[derive(Deserialize)]
pub struct EmailQuery {
    pub account_id: Option<i32>,
    pub before: Option<i64>,
    pub before_id: Option<i32>,
    pub folder: Option<String>,
    pub q: Option<String>,
    /// Shared-inbox workflow filter:
    ///   `open` | `pending` | `closed` — match `shared_inbox_email_state.status`
    ///   `unassigned` — has a state row but no assignee
    ///   `mine` — assigned to the calling user
    /// Any other value is ignored.
    pub inbox_status: Option<String>,
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

    let page_size = 75;
    let query_limit = page_size + 1;

    let before = query.before.zip(query.before_id);

    let filters = EmailListFilters {
        user_id,
        account_id: query.account_id,
        folder: query.folder.clone(),
        inbox_status: query.inbox_status.clone(),
        search: query.q.clone(),
        before,
        page_size,
    };

    // DB-first: query what we already have cached before doing any upstream
    // work. The previous behavior always did a synchronous Gmail/Outlook
    // sync on every "load more" click, which added 3-10s of latency even
    // when the DB had plenty of older rows cached. Now we only block on
    // the provider when the cache is genuinely exhausted; otherwise the
    // sync runs in the background so the next click is fresh.
    let mut rows = repo::list(pool.get_ref(), filters.clone()).await?;

    if let Some(before_ms) = query.before {
        let account_id = query.account_id;
        // sync_older_page expects Unix seconds; the wire format is
        // milliseconds for sub-second precision on the DB keyset cursor.
        let before_secs = before_ms / 1000;

        if rows.len() > page_size {
            // Full page available locally — return immediately and refill
            // the cache in the background so the next click stays fast.
            let pool_clone = pool.get_ref().clone();
            tokio::spawn(async move {
                if let Err(e) = sync_older_page(
                    &pool_clone,
                    user_id,
                    account_id,
                    before_secs,
                    query_limit,
                )
                .await
                {
                    warn!(target: "gmail", user_id, error = ?e, "background older email sync failed");
                }
            });
        } else {
            // Local cache exhausted — pay the provider round-trip inline
            // so we can return the next page instead of an empty response.
            if let Err(e) = sync_older_page(
                pool.get_ref(),
                user_id,
                account_id,
                before_secs,
                query_limit,
            )
            .await
            {
                warn!(target: "gmail", user_id, error = ?e, "older email page sync failed");
            }
            rows = repo::list(pool.get_ref(), filters).await?;
        }
    }

    let has_more = rows.len() > page_size;
    let emails: Vec<Value> = rows
        .into_iter()
        .take(page_size)
        .map(|row| {
            let created_at = row.created_at.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });
            serde_json::json!({
                "id": row.id,
                "gmail_id": row.gmail_id,
                "subject": row.subject,
                "sender": row.sender,
                "receiver": row.receiver,
                "has_body": row.has_body,
                "has_attachments": row.has_attachments,
                "account_id": row.account_id,
                "is_read": row.is_read,
                "created_at": created_at,
                "is_shared": row.is_shared,
                "shared_label": row.shared_label,
                "inbox_status": row.inbox_status,
                "inbox_assignee_id": row.inbox_assignee_id,
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

    let rows = repo::list_attachments_for_user(pool.get_ref(), user_id).await?;

    let files: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let created_at = row.created_at.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });
            serde_json::json!({
                "id": row.id,
                "email_id": row.email_id,
                "filename": row.filename,
                "mime_type": row.mime_type,
                "size": row.size,
                "created_at": created_at,
                "subject": row.subject,
                "sender": row.sender,
                "receiver": row.receiver,
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(files))
}

// Total unread email count across all of the caller's accounts. Powers the
// global sidebar/header badge so it doesn't have to load the full inbox to
// count. Backed by `idx_emails_unread` (partial index on `is_read = false`)
// so the query is an index-only scan regardless of inbox size.
#[get("/emails/unread-count")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_unread_count(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) \
         FROM emails e \
         JOIN email_accounts a ON a.id = e.account_id \
         WHERE a.user_id = $1 AND e.is_read = false",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "count": count })))
}

// Mark an email as read for the authenticated user. The frontend already
// flips `is_read` optimistically when the user opens an email, but without
// this endpoint the change isn't persisted — refreshing the inbox showed
// the row as unread again. We update Wayve's own `emails.is_read` first
// (canonical, drives the UI), then spawn a fire-and-forget task that
// refreshes the provider OAuth token and pushes the read state to Gmail
// (remove UNREAD label) / Outlook (PATCH isRead=true). Provider push
// failures are logged but don't fail the request — the worst case is
// Wayve and the provider's web UI showing different states until the next
// sync reconciles, which is strictly better than a refresh wiping the
// local update.
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
    // through email_accounts.user_id is the authorization gate. RETURNING
    // lets us pick up the provider message id + refresh token in the same
    // query so we don't need a second round-trip for the push step.
    let updated = sqlx::query(
        r#"
        UPDATE emails AS e
           SET is_read = TRUE
          FROM email_accounts AS a
         WHERE e.account_id = a.id
           AND e.id = $1
           AND a.user_id = $2
           AND e.is_read = FALSE
        RETURNING e.gmail_id, a.id AS account_id, a.refresh_token, a.provider
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(row) = updated {
        let provider_message_id: String = row.get("gmail_id");
        let account_id: i32 = row.get("account_id");

        // Decrement the cached provider unread count optimistically so the
        // sidebar badge matches the user's local action without waiting for
        // the next 30-second sync to re-query Gmail/Outlook. GREATEST clamps
        // at zero in case our count is stale and would otherwise go negative.
        sqlx::query(
            "UPDATE email_accounts \
             SET provider_unread_count = GREATEST(COALESCE(provider_unread_count, 0) - 1, 0) \
             WHERE id = $1",
        )
        .bind(account_id)
        .execute(pool.get_ref())
        .await
        .ok();
        let provider = row
            .try_get::<String, _>("provider")
            .map(|value| MailProvider::from_db(&value))
            .unwrap_or(MailProvider::Google);
        let refresh_token: Option<String> = row.get("refresh_token");

        if let Some(refresh_token) = refresh_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        {
            // Detach from the request — the provider call can take a few
            // hundred ms (token refresh + HTTPS round-trip) and the client
            // already considers this done.
            let pool_clone = pool.get_ref().clone();
            tokio::spawn(async move {
                push_read_state_to_provider(
                    &pool_clone,
                    user_id,
                    account_id,
                    provider,
                    &refresh_token,
                    &provider_message_id,
                )
                .await;
            });
        } else {
            warn!(
                target: "gmail",
                user_id,
                account_id,
                provider = provider.as_db(),
                email_id,
                "mark-read: no refresh token; provider push skipped"
            );
        }

        return Ok(HttpResponse::Ok().json(serde_json::json!({ "is_read": true })));
    }

    // RETURNING gave no row. Two possibilities:
    //   - email doesn't exist / isn't owned by this user (treat as 404)
    //   - email was already marked read (treat as no-op success — no
    //     provider push needed, the state is already in sync)
    let owns: Option<i32> = sqlx::query_scalar(
        "SELECT e.id FROM emails e JOIN email_accounts a ON e.account_id = a.id \
         WHERE e.id = $1 AND a.user_id = $2",
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    if owns.is_none() {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "error": "Email not found" })));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "is_read": true })))
}

#[instrument(target = "gmail", skip(pool, refresh_token), fields(user_id, account_id, provider = provider.as_db()))]
#[allow(clippy::too_many_arguments)]
async fn push_read_state_to_provider(
    pool: &PgPool,
    user_id: i32,
    account_id: i32,
    provider: MailProvider,
    refresh_token: &str,
    provider_message_id: &str,
) {
    let token =
        match refresh_and_persist_email_token(pool, account_id, provider, refresh_token).await {
            Ok(token) => token.access_token,
            Err(e) => {
                warn!(
                    target: "gmail",
                    user_id,
                    account_id,
                    provider = provider.as_db(),
                    error = ?e,
                    "mark-read token refresh failed; provider push skipped"
                );
                return;
            }
        };

    if let Err(e) = provider.mark_read(&token, provider_message_id).await {
        warn!(
            target: "gmail",
            user_id,
            account_id,
            provider = provider.as_db(),
            error = ?e,
            "mark-read provider push failed; Wayve DB state stands"
        );
    }
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
