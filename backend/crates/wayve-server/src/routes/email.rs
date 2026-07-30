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

#[derive(Deserialize)]
pub struct ContactSearchQuery {
    pub q: String,
}

/// Escapes LIKE metacharacters (`\` `%` `_`) so user input is matched literally
/// inside a `%…%` ILIKE pattern rather than acting as a wildcard.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Compose "To" typeahead: substring search over the caller's own contacts
/// projection (`email_contacts`), most-frequent first. Scoped explicitly by
/// `user_id`; a short query returns an empty list.
#[get("/contacts/search")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn search_contacts(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ContactSearchQuery>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let trimmed = query.q.trim();
    if trimmed.chars().count() < 2 {
        return Ok(HttpResponse::Ok().json(Vec::<Value>::new()));
    }

    let pattern = format!("%{}%", escape_like(trimmed));
    let rows = sqlx::query(
        "SELECT address, display_name FROM email_contacts \
         WHERE user_id = $1 AND (address ILIKE $2 OR display_name ILIKE $2) \
         ORDER BY message_count DESC, last_seen_at DESC \
         LIMIT 10",
    )
    .bind(user_id)
    .bind(&pattern)
    .fetch_all(pool.get_ref())
    .await?;

    let contacts: Vec<_> = rows
        .into_iter()
        .map(|r| {
            let address: String = r.get("address");
            let display_name: Option<String> = r.get("display_name");
            serde_json::json!({ "address": address, "display_name": display_name })
        })
        .collect();

    Ok(HttpResponse::Ok().json(contacts))
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

    let page_size = 25;
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

    // DB-first: the provider is only blocked on when the local cache is exhausted,
    // because a synchronous sync on every "load more" click costs seconds of
    // latency even when the DB already holds the rows.
    let mut rows = repo::list(pool.get_ref(), filters.clone()).await?;

    if let Some(before_ms) = query.before {
        let account_id = query.account_id;
        // sync_older_page expects Unix seconds; the wire format is milliseconds, for
        // sub-second precision on the DB keyset cursor.
        let before_secs = before_ms / 1000;

        if rows.len() > page_size {
            // A full page is available locally, so refill in the background.
            let pool_clone = pool.get_ref().clone();
            tokio::spawn(async move {
                if let Err(e) =
                    sync_older_page(&pool_clone, user_id, account_id, before_secs, query_limit)
                        .await
                {
                    warn!(target: "gmail", user_id, error = ?e, "background older email sync failed");
                }
            });
        } else {
            // Cache exhausted, so pay the provider round-trip inline rather than
            // return an empty page.
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
    // LEFT JOIN so account-less Fluxze-native rows still match; they are
    // authorized instead via the source/recipient clause, as in repo::get_detail.
    let row = match sqlx::query(
        r#"
        SELECT e.gmail_id, e.source, e.account_id, a.refresh_token, a.provider,
               e.subject, e.sender, e.receiver
        FROM emails e
        LEFT JOIN email_accounts a ON e.account_id = a.id
        WHERE e.id = $1
          AND (a.user_id = $2
               OR (e.source = 'wayve' AND e.recipient_user_id = $2))
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

    // Captured before the row is gone, for the audit record on each success path.
    let del_subject: Option<String> = row.try_get("subject").ok().flatten();
    let del_sender: Option<String> = row.try_get("sender").ok().flatten();
    let del_receiver: Option<String> = row.try_get("receiver").ok().flatten();
    let del_provider: Option<String> = row.try_get("provider").ok().flatten();
    let delete_metadata = serde_json::json!({
        "direction": "deleted",
        "from": del_sender,
        "to": del_receiver,
        "subject": del_subject,
        "provider": del_provider,
    });

    // Fluxze-native messages have no provider copy to delete: their synthetic
    // gmail_id is not a real Gmail or Graph id. Only this user's local row is
    // dropped, since each recipient and the sender's Sent copy is its own row.
    let source: Option<String> = row.try_get("source").ok().flatten();
    let account_id_opt: Option<i32> = row.try_get("account_id").ok().flatten();
    if account_id_opt.is_none() || source.as_deref() == Some("wayve") {
        sqlx::query("DELETE FROM emails WHERE id = $1")
            .bind(email_id)
            .execute(pool.get_ref())
            .await?;
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "email_deleted",
                resource_type: "email",
                resource_id: Some(email_id.to_string()),
                metadata: Some(delete_metadata),
            },
        )
        .await;
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })));
    }

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
        // Trash, not permanent delete: `messages.delete` needs the full
        // `https://mail.google.com/` scope, which we do not request, so it 403s and the
        // row resurrects on the next sync. `messages.trash` works under `gmail.modify`.
        let url = format!(
            "{}/gmail/v1/users/me/messages/{}/trash",
            crate::external::gmail_api_base(),
            gmail_id
        );
        // The empty JSON object is load-bearing: `messages.trash` is a bodyless POST,
        // reqwest omits Content-Length for an empty body, and Google's frontend 411s
        // without one. The endpoint itself ignores the body.
        HTTP_CLIENT
            .post(url)
            .bearer_auth(&token)
            .json(&serde_json::json!({}))
            .send()
            .await
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

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "email_deleted",
            resource_type: "email",
            resource_id: Some(email_id.to_string()),
            metadata: Some(delete_metadata),
        },
    )
    .await;

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

/// Unread inbox count across the caller's accounts, powering the nav badge.
///
/// Must stay in sync with the per-account `unread_count` in `email::account`: prefer
/// the provider's authoritative `provider_unread_count` (INBOX only), falling back to
/// a local COUNT that excludes SPAM, DRAFT, and self-sent mail before the first sync.
/// Summing per account is what makes this badge equal the "All Accounts" badge.
#[get("/emails/unread-count")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_unread_count(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(unread), 0)::BIGINT
        FROM (
          SELECT COALESCE(
            a.provider_unread_count::BIGINT,
            COUNT(e.id) FILTER (
              WHERE e.is_read = false
                AND lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%'
                AND NOT ('SPAM' = ANY(e.labels))
                AND NOT ('DRAFT' = ANY(e.labels))
            )::BIGINT
          ) AS unread
          FROM email_accounts a
          LEFT JOIN emails e ON e.account_id = a.id
          WHERE a.user_id = $1
          GROUP BY a.id, a.email, a.provider_unread_count
        ) t
        "#,
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "count": count })))
}

/// Persist the read state the frontend already flipped optimistically.
///
/// `emails.is_read` is canonical and drives the UI, so it is written first and the
/// provider push runs fire-and-forget. A failed push is logged but does not fail the
/// request: at worst Wayve and the provider's web UI disagree until the next sync,
/// which beats a refresh wiping the update.
#[actix_web::post("/emails/{id}/read")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn mark_email_read(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.id;

    // The join through email_accounts.user_id is the authorization gate: a user may
    // only mark their own emails read. RETURNING picks up the provider message id
    // and refresh token in the same query.
    let updated = sqlx::query(
        r#"
        UPDATE emails AS e
           SET is_read = TRUE
          FROM email_accounts AS a
         WHERE e.account_id = a.id
           AND e.id = $1
           AND a.user_id = $2
           AND e.is_read = FALSE
        RETURNING e.gmail_id, a.id AS account_id, a.refresh_token, a.provider,
                  e.subject, e.sender, e.receiver
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(row) = updated {
        let provider_message_id: String = row.get("gmail_id");
        let account_id: i32 = row.get("account_id");

        // email_attachments is joined so the security activity view can show the
        // files that rode along; they are populated by read time.
        let subject: Option<String> = row.try_get("subject").ok();
        let sender: Option<String> = row.try_get("sender").ok();
        let receiver: Option<String> = row.try_get("receiver").ok();
        let read_provider: Option<String> = row.try_get("provider").ok();
        let attachment_names: Vec<String> = sqlx::query_scalar(
            "SELECT filename FROM email_attachments WHERE email_id = $1 ORDER BY id",
        )
        .bind(email_id)
        .fetch_all(pool.get_ref())
        .await
        .unwrap_or_default();
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "email_read",
                resource_type: "email",
                resource_id: Some(email_id.to_string()),
                metadata: Some(serde_json::json!({
                    "direction": "read",
                    "from": sender,
                    "to": receiver,
                    "subject": subject,
                    "provider": read_provider,
                    "attachments": attachment_names,
                    "attachment_count": attachment_names.len(),
                })),
            },
        )
        .await;

        // Decrement optimistically so the sidebar badge matches the user's action
        // without waiting for the next sync. GREATEST clamps at zero, since a stale
        // cached count could otherwise go negative.
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
            // Detached from the request: the token refresh and HTTPS round-trip cost
            // hundreds of milliseconds, and the client already considers this done.
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

    // No row from RETURNING means the email is either not owned by this user (404)
    // or already read, in which case no provider push is needed.
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

#[actix_web::post("/emails/{id}/unread")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn mark_email_unread(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.id;

    // Mirror of mark_email_read: the account join authorizes, and the
    // `AND e.is_read = TRUE` guard makes a re-mark a no-op with no provider push.
    let updated = sqlx::query(
        r#"
        UPDATE emails AS e
           SET is_read = FALSE
          FROM email_accounts AS a
         WHERE e.account_id = a.id
           AND e.id = $1
           AND a.user_id = $2
           AND e.is_read = TRUE
        RETURNING e.gmail_id, a.id AS account_id, a.refresh_token, a.provider,
                  e.subject, e.sender, e.receiver
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(row) = updated {
        let provider_message_id: String = row.get("gmail_id");
        let account_id: i32 = row.get("account_id");

        let subject: Option<String> = row.try_get("subject").ok();
        let sender: Option<String> = row.try_get("sender").ok();
        let receiver: Option<String> = row.try_get("receiver").ok();
        let unread_provider: Option<String> = row.try_get("provider").ok();
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "email_unread",
                resource_type: "email",
                resource_id: Some(email_id.to_string()),
                metadata: Some(serde_json::json!({
                    "direction": "unread",
                    "from": sender,
                    "to": receiver,
                    "subject": subject,
                    "provider": unread_provider,
                })),
            },
        )
        .await;

        // Bump the cached unread count back up to mirror the reversal.
        sqlx::query(
            "UPDATE email_accounts \
             SET provider_unread_count = COALESCE(provider_unread_count, 0) + 1 \
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
            let pool_clone = pool.get_ref().clone();
            tokio::spawn(async move {
                push_unread_state_to_provider(
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
                "mark-unread: no refresh token; provider push skipped"
            );
        }

        return Ok(HttpResponse::Ok().json(serde_json::json!({ "is_read": false })));
    }

    // No row means not owned (404) or already unread (nothing to push).
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

    Ok(HttpResponse::Ok().json(serde_json::json!({ "is_read": false })))
}

/// Extract the bare address from an RFC 5322 `Name <addr@host>` sender header,
/// falling back to the token that looks like an address when it's already bare.
fn extract_sender_address(sender: &str) -> Option<String> {
    let s = sender.trim();
    // Prefer the address inside angle brackets when the header is "Name <addr>".
    let bracketed = match (s.find('<'), s.rfind('>')) {
        (Some(open), Some(close)) if open < close => s.get(open + 1..close).map(str::trim),
        _ => None,
    };
    if let Some(inner) = bracketed.filter(|i| i.contains('@')) {
        return Some(inner.to_lowercase());
    }
    s.split_whitespace()
        .rev()
        .find(|token| token.contains('@'))
        .map(|token| {
            token
                .trim_matches(|c| c == '<' || c == '>' || c == '"' || c == ',')
                .to_lowercase()
        })
}

// Mark the sender of email {id} as "noise": all of that address's mail (current
// and future) then routes into the Noise folder and out of the inbox — the
// filtering lives in email/repo.rs, so no rows are rewritten here.
#[actix_web::post("/emails/{id}/noise")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn mark_email_noise(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.id;

    // The join authorizes: a user may only act on their own mail (owned via
    // account, or delivered to them for wayve-source rows).
    let sender: Option<Option<String>> = sqlx::query_scalar(
        "SELECT e.sender FROM emails e \
         LEFT JOIN email_accounts a ON e.account_id = a.id \
         WHERE e.id = $1 AND (a.user_id = $2 OR e.recipient_user_id = $2)",
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(sender) = sender else {
        return Err(AppError::NotFound("email"));
    };
    let address = sender
        .as_deref()
        .and_then(extract_sender_address)
        .ok_or_else(|| AppError::bad_request("email has no usable sender address"))?;

    let insert_addr = address.clone();
    crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        sqlx::query(
            "INSERT INTO noise_senders (user_id, sender_email) VALUES ($1, $2) \
             ON CONFLICT (user_id, sender_email) DO NOTHING",
        )
        .bind(user_id)
        .bind(&insert_addr)
        .execute(&mut *tx)
        .await?;
        Ok((tx, ()))
    })
    .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "email_sender_marked_noise",
            resource_type: "email",
            resource_id: Some(email_id.to_string()),
            metadata: Some(serde_json::json!({ "sender_email": address })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "marked": true, "sender_email": address })))
}

#[instrument(target = "gmail", skip(pool, refresh_token), fields(user_id, account_id, provider = provider.as_db()))]
#[allow(clippy::too_many_arguments)]
async fn push_unread_state_to_provider(
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
                    "mark-unread token refresh failed; provider push skipped"
                );
                return;
            }
        };

    if let Err(e) = provider.mark_unread(&token, provider_message_id).await {
        warn!(
            target: "gmail",
            user_id,
            account_id,
            provider = provider.as_db(),
            error = ?e,
            "mark-unread provider push failed; Wayve DB state stands"
        );
    }
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
