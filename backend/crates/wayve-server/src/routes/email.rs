use crate::cache::Cache;
use crate::email::outlook::{OutlookAttachmentRef, download_outlook_attachment};
use crate::email::provider::{MailProvider, TrashMoved, refresh_and_persist_email_token};
use crate::email::repo::{self, EmailListFilters};
use crate::email::sync_older::{OlderPage, sync_older_page};
use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use actix_web::http::header;
use actix_web::{HttpRequest, HttpResponse, delete, get, web};
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
    /// `1` / `true`: one row per conversation (Gmail-style), positioned by its
    /// newest message. Spam, drafts and trash stay per email.
    pub threads: Option<String>,
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
        "SELECT address, display_name, photo_url FROM email_contacts \
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
            let photo_url: Option<String> = r.get("photo_url");
            serde_json::json!({
                "address": address,
                "display_name": display_name,
                "photo_url": photo_url,
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(contacts))
}

/// Extra provider round-trips a grouped "load more" may make when the synced
/// mail collapsed into conversations already shown (see `get_emails`).
const MAX_EXTRA_OLDER_SYNCS: usize = 3;

/// Unix seconds of the oldest synced email in the caller's own mailboxes (or one
/// of them), i.e. how far back the local copy reaches. `None` when empty. With
/// `inbox_only`, Gmail mail counts only if it is in the inbox, matching what an
/// inbox-only older sync fetches.
async fn oldest_synced_secs(
    pool: &PgPool,
    user_id: i32,
    account_id: Option<i32>,
    inbox_only: bool,
) -> Option<i64> {
    let oldest: Option<chrono::NaiveDateTime> = sqlx::query_scalar(
        "SELECT MIN(e.created_at) FROM emails e \
         JOIN email_accounts a ON a.id = e.account_id \
         WHERE a.user_id = $1 AND ($2::int IS NULL OR a.id = $2) \
           AND (NOT $3 OR a.provider <> 'google' OR 'INBOX' = ANY(e.labels))",
    )
    .bind(user_id)
    .bind(account_id)
    .bind(inbox_only)
    .fetch_one(pool)
    .await
    .ok()
    .flatten();
    oldest.map(|dt| dt.and_utc().timestamp())
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
        group_threads: matches!(query.threads.as_deref(), Some("1" | "true")),
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
        // These views list only inbox mail, so fetch only that from Gmail.
        let inbox_only = matches!(
            filters.folder.as_deref(),
            Some("inbox" | "signal" | "noise")
        );
        let page = OlderPage {
            before_timestamp: before_secs,
            limit: query_limit,
            inbox_only,
        };

        if rows.len() > page_size {
            // A full page is available locally, so refill in the background.
            let pool_clone = pool.get_ref().clone();
            tokio::spawn(async move {
                if let Err(e) = sync_older_page(&pool_clone, user_id, account_id, page).await {
                    warn!(target: "gmail", user_id, error = ?e, "background older email sync failed");
                }
            });
        } else {
            // Cache exhausted, so pay the provider round-trip inline rather than
            // return an empty page.
            if let Err(e) = sync_older_page(pool.get_ref(), user_id, account_id, page).await {
                warn!(target: "gmail", user_id, error = ?e, "older email page sync failed");
            }
            rows = repo::list(pool.get_ref(), filters.clone()).await?;

            // Conversation rows: the older mail just synced can all belong to
            // conversations already shown higher up (their newest message is
            // newer than the cursor), which leaves this page empty and would end
            // the scroll with older mail still upstream. While the sync keeps
            // reaching further back, keep going from the oldest email it brought.
            if filters.group_threads {
                let mut floor =
                    oldest_synced_secs(pool.get_ref(), user_id, account_id, inbox_only).await;
                for _ in 0..MAX_EXTRA_OLDER_SYNCS {
                    let Some(oldest) = floor else { break };
                    if !rows.is_empty() || oldest >= before_secs {
                        break;
                    }
                    let older = OlderPage {
                        before_timestamp: oldest,
                        ..page
                    };
                    if let Err(e) =
                        sync_older_page(pool.get_ref(), user_id, account_id, older).await
                    {
                        warn!(target: "gmail", user_id, error = ?e, "older email page sync failed");
                        break;
                    }
                    rows = repo::list(pool.get_ref(), filters.clone()).await?;
                    let next =
                        oldest_synced_secs(pool.get_ref(), user_id, account_id, inbox_only).await;
                    if next.is_none_or(|n| n >= oldest) {
                        break; // the provider had nothing older
                    }
                    floor = next;
                }
            }
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
                "thread_id": row.thread_id,
                "message_count": row.message_count,
                "unread_count": row.unread_count,
                "message_ids": row.message_ids,
                "unread_ids": row.unread_ids,
                "is_starred": row.is_starred,
                "starred_ids": row.starred_ids,
                "participants": row.participants,
            })
        })
        .collect();

    info!(target: "http", user_id, count = emails.len(), "Fetched emails");
    Ok(HttpResponse::Ok()
        .append_header(("x-has-more", has_more.to_string()))
        .json(emails))
}

/// Which way `move_email` moves an email: into Trash, which is what Delete
/// does, or back out of it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum TrashDirection {
    Trash,
    Restore,
}

impl TrashDirection {
    /// For messages: "Reconnect your email account to delete this email".
    fn verb(self) -> &'static str {
        match self {
            Self::Trash => "delete",
            Self::Restore => "restore",
        }
    }
}

#[delete("/emails/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    move_email(&req, pool.get_ref(), path.id, TrashDirection::Trash).await
}

#[actix_web::post("/emails/{id}/restore")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn restore_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    move_email(&req, pool.get_ref(), path.id, TrashDirection::Restore).await
}

/// Delete moves an email to Trash instead of dropping it, so it can be restored.
/// The provider's copy goes to the provider's trash (Gmail Trash, Outlook
/// Deleted Items) and the stored row gets the TRASH label, which the Trash
/// folder lists and every other folder hides (see repo::push_folder). Restore
/// reverses both. Fluxze-to-Fluxze and IMAP mail are trashed in Fluxze only:
/// the former has no provider copy, and moving IMAP mail on the server isn't
/// built yet, so sync keeps the label instead (see repo::upsert_one).
async fn move_email(
    req: &HttpRequest,
    pool: &PgPool,
    email_id: i32,
    direction: TrashDirection,
) -> AppResult {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let email = match load_owned_email(pool, user_id, email_id, direction.verb()).await? {
        Ok(email) => email,
        Err(response) => return Ok(response),
    };

    let mut moved = TrashMoved {
        new_id: None,
        // Fluxze-only moves keep the row's labels, so a restore puts it back
        // wherever it was, the inbox included.
        in_inbox: false,
    };
    if let Some(remote) = &email.remote {
        let result = match direction {
            TrashDirection::Trash => {
                remote
                    .provider
                    .trash(&remote.token, &remote.message_id)
                    .await
            }
            TrashDirection::Restore => {
                remote
                    .provider
                    .restore(&remote.token, &remote.message_id)
                    .await
            }
        };
        moved = match result {
            Ok(moved) => moved,
            Err(e) => {
                error!(target: "gmail", user_id, provider = remote.provider.as_db(), email_id, ?direction, error = ?e, "provider trash move failed");
                return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                    "error": format!("Email provider rejected the {} request", direction.verb())
                })));
            }
        };
    }

    repo::set_trashed(pool, email_id, direction == TrashDirection::Trash, &moved).await?;

    let row = &email.row;
    crate::audit::record_action(
        pool,
        req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: match direction {
                TrashDirection::Trash => "email_deleted",
                TrashDirection::Restore => "email_restored",
            },
            resource_type: "email",
            resource_id: Some(email_id.to_string()),
            metadata: Some(serde_json::json!({
                "direction": match direction {
                    TrashDirection::Trash => "deleted",
                    TrashDirection::Restore => "restored",
                },
                "from": row.try_get::<Option<String>, _>("sender").ok().flatten(),
                "to": row.try_get::<Option<String>, _>("receiver").ok().flatten(),
                "subject": row.try_get::<Option<String>, _>("subject").ok().flatten(),
                "provider": email.provider.map(MailProvider::as_db),
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "trashed": direction == TrashDirection::Trash
    })))
}

#[actix_web::post("/emails/{id}/star")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn star_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    set_star(&req, pool.get_ref(), path.id, true).await
}

#[actix_web::post("/emails/{id}/unstar")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn unstar_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<EmailDeletePath>,
) -> AppResult {
    set_star(&req, pool.get_ref(), path.id, false).await
}

/// Stars or unstars one message, as in Gmail: the STARRED label here and at the
/// provider (Gmail's label, Outlook's flag). Waits for the provider, so a
/// failure reaches the client, which puts the star back. Fluxze-to-Fluxze and
/// IMAP stars are kept in Fluxze only (see `load_owned_email`).
async fn set_star(req: &HttpRequest, pool: &PgPool, email_id: i32, starred: bool) -> AppResult {
    let user_id = get_user_id_from_request(req).ok_or(AppError::Unauthorized)?;
    let verb = if starred { "star" } else { "unstar" };
    let email = match load_owned_email(pool, user_id, email_id, verb).await? {
        Ok(email) => email,
        Err(response) => return Ok(response),
    };

    if let Some(remote) = &email.remote
        && let Err(e) = remote
            .provider
            .set_starred(&remote.token, &remote.message_id, starred)
            .await
    {
        error!(target: "gmail", user_id, provider = remote.provider.as_db(), email_id, starred, error = ?e, "provider star failed");
        return Ok(HttpResponse::BadGateway().json(serde_json::json!({
            "error": format!("Email provider rejected the {verb} request")
        })));
    }

    repo::set_starred(pool, email_id, starred).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "is_starred": starred })))
}

/// An email the caller may change (trash, restore, star).
struct OwnedEmail {
    /// subject / sender / receiver, for the audit record.
    row: sqlx::postgres::PgRow,
    provider: Option<MailProvider>,
    /// The provider copy to change too. None for Fluxze-to-Fluxze mail, whose
    /// synthetic gmail_id is not a real Gmail or Graph id, and for IMAP, which
    /// is changed in Fluxze only for now.
    remote: Option<RemoteEmail>,
}

struct RemoteEmail {
    provider: MailProvider,
    message_id: String,
    token: String,
}

/// Loads an email the caller owns and, when it has a provider copy, a fresh
/// access token for it. The inner `Err` is a response to return as is: 404 for
/// mail that isn't theirs, 409 when the mailbox needs reconnecting, 502 when
/// the token refresh fails. `verb` completes "Reconnect your email account to
/// … this email".
async fn load_owned_email(
    pool: &PgPool,
    user_id: i32,
    email_id: i32,
    verb: &str,
) -> Result<Result<OwnedEmail, HttpResponse>, AppError> {
    // LEFT JOIN so account-less Fluxze-native rows still match; they are
    // authorized instead via the source/recipient clause, as in repo::get_detail.
    let Some(row) = sqlx::query(
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
    .fetch_optional(pool)
    .await?
    else {
        return Ok(Err(HttpResponse::NotFound().json(serde_json::json!({
            "error": "Email not found"
        }))));
    };

    let provider = row
        .try_get::<Option<String>, _>("provider")
        .ok()
        .flatten()
        .map(|value| MailProvider::from_db(&value));
    let source: Option<String> = row.try_get("source").ok().flatten();
    let account_id: Option<i32> = row.try_get("account_id").ok().flatten();

    let (Some(account_id), Some(remote_provider)) = (account_id, provider) else {
        return Ok(Ok(OwnedEmail {
            row,
            provider,
            remote: None,
        }));
    };
    if source.as_deref() == Some("wayve") || remote_provider == MailProvider::Imap {
        return Ok(Ok(OwnedEmail {
            row,
            provider,
            remote: None,
        }));
    }

    let message_id: String = row.get("gmail_id");
    let refresh_token: Option<String> = row.get("refresh_token");
    let Some(refresh_token) = refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // 409, not 401: the user's session is fine, only the mailbox needs
        // reconnecting. The client treats any 401 as an expired session and
        // logs the user out, as for the body fetch (email/body_handlers.rs).
        return Ok(Err(HttpResponse::Conflict().json(serde_json::json!({
            "error": format!("Reconnect your email account to {verb} this email")
        }))));
    };

    let token = match refresh_and_persist_email_token(
        pool,
        account_id,
        remote_provider,
        refresh_token,
    )
    .await
    {
        Ok(token) => token.access_token,
        Err(e) => {
            error!(target: "gmail", user_id, account_id, provider = remote_provider.as_db(), verb, error = ?e, "email token refresh failed");
            return Ok(Err(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Failed to refresh email account credentials"
            }))));
        }
    };

    Ok(Ok(OwnedEmail {
        row,
        provider,
        remote: Some(RemoteEmail {
            provider: remote_provider,
            message_id,
            token,
        }),
    }))
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
/// a local COUNT that excludes SPAM, DRAFT, and self-sent mail before the first sync
/// (and, for Gmail, anything not labelled INBOX).
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
                AND (a.provider <> 'google' OR 'INBOX' = ANY(e.labels))
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

    // A Fluxze-to-Fluxze email has no mailbox for the update above to join.
    if set_native_read_state(pool.get_ref(), &req, user_id, email_id, true)
        .await?
        .is_some()
    {
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

/// Sets the read state of a Fluxze-to-Fluxze email (`source = 'wayve'`). It
/// belongs to its recipient (`recipient_user_id`), not to a connected mailbox, so
/// the mailbox-joined updates in `mark_email_read`/`mark_email_unread` never
/// match it — which left such mail unread however often it was opened. There
/// is no provider copy to push to. `Some(changed)` when the caller is the
/// email's recipient, `None` when it isn't theirs (or isn't Fluxze mail).
async fn set_native_read_state(
    pool: &PgPool,
    req: &HttpRequest,
    user_id: i32,
    email_id: i32,
    read: bool,
) -> Result<Option<bool>, AppError> {
    let changed = sqlx::query(
        "UPDATE emails SET is_read = $3 \
         WHERE id = $1 AND source = 'wayve' AND recipient_user_id = $2 AND is_read <> $3 \
         RETURNING subject, sender, receiver",
    )
    .bind(email_id)
    .bind(user_id)
    .bind(read)
    .fetch_optional(pool)
    .await?;

    let Some(row) = changed else {
        let owns: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM emails WHERE id = $1 AND source = 'wayve' AND recipient_user_id = $2",
        )
        .bind(email_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
        return Ok(owns.map(|_| false));
    };

    let direction = if read { "read" } else { "unread" };
    crate::audit::record_action(
        pool,
        req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: if read { "email_read" } else { "email_unread" },
            resource_type: "email",
            resource_id: Some(email_id.to_string()),
            metadata: Some(serde_json::json!({
                "direction": direction,
                "from": row.try_get::<Option<String>, _>("sender").ok().flatten(),
                "to": row.try_get::<Option<String>, _>("receiver").ok().flatten(),
                "subject": row.try_get::<Option<String>, _>("subject").ok().flatten(),
                "provider": "wayve",
            })),
        },
    )
    .await;
    Ok(Some(true))
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

    // A Fluxze-to-Fluxze email has no mailbox for the update above to join.
    if set_native_read_state(pool.get_ref(), &req, user_id, email_id, false)
        .await?
        .is_some()
    {
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

/// How long opening a conversation waits for its missing messages.
const COMPLETE_CONVERSATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Every message of this email's conversation, oldest first, as list rows. The
/// bodies still load per message through `/emails/{id}` and `/emails/{id}/body`,
/// so encryption and provider fetching are unchanged. 404 when the caller can't
/// see the email.
#[get("/emails/{id}/thread")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_email_thread(
    req: HttpRequest,
    path: web::Path<i32>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.into_inner();
    let mut rows = repo::thread_messages(pool.get_ref(), email_id, user_id).await?;
    if rows.is_empty() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Email not found" }))
        );
    }
    // The first open of a Gmail conversation fetches the messages it is
    // missing (your replies, archived ones). Bounded, so a slow provider costs
    // at most a few seconds; on failure or timeout the conversation shows what
    // is stored and the next open tries again.
    match tokio::time::timeout(
        COMPLETE_CONVERSATION_TIMEOUT,
        crate::email::complete::complete_conversation(pool.get_ref(), user_id, email_id),
    )
    .await
    {
        Ok(Ok(true)) => rows = repo::thread_messages(pool.get_ref(), email_id, user_id).await?,
        Ok(Ok(false)) => {}
        Ok(Err(e)) => {
            warn!(target: "gmail", user_id, email_id, error = ?e, "conversation completion failed")
        }
        Err(_) => warn!(target: "gmail", user_id, email_id, "conversation completion timed out"),
    }
    let messages: Vec<Value> = rows
        .into_iter()
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
                "is_starred": row.is_starred,
                "created_at": created_at,
                "is_shared": row.is_shared,
                "shared_label": row.shared_label,
                "inbox_status": row.inbox_status,
                "inbox_assignee_id": row.inbox_assignee_id,
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(messages))
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

    let bytes = match crate::email::attachments::fetch_gmail_attachment_bytes(
        &token.access_token,
        &gmail_id,
        &gmail_attachment_id,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            error!(target: "gmail", error = ?e, "attachment download failed");
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
