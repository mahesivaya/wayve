//! Manual repair path: re-fetches provider metadata for every row an account
//! owns and overwrites the stored subject, sender, receiver, and labels. An
//! early sync wrote placeholder subjects for some accounts, and the forward sync
//! only rewrites a row when a new copy of the message arrives, so it can never
//! fix them on its own.
//!
//! Owner-only and Google-only. Concurrency is capped at 10 in-flight
//! `messages.get` calls: Gmail allows 250 quota units per user per second and
//! each metadata fetch costs 5, leaving headroom for the other workers.

use crate::email::account::{EmailAccount, load_email_account_for_user};
use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
use crate::email::sync::fetch_headers_only;
use crate::error::{AppError, AppResult};
use actix_web::{HttpRequest, HttpResponse, post, web};
use futures::stream::{FuturesUnordered, StreamExt};
use sqlx::PgPool;
use sqlx::Row;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

const CONCURRENCY: usize = 10;

#[post("/email/accounts/{id}/rehydrate")]
#[instrument(target = "gmail", skip(req, pool))]
pub async fn rehydrate_account(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let account_id = path.into_inner();

    // A non-owned account is a 404, not a 403, so account ids don't leak.
    let account: EmailAccount =
        match load_email_account_for_user(pool.get_ref(), account_id, user_id).await? {
            Some(a) => a,
            None => return Err(AppError::NotFound("email account")),
        };

    // Outlook and IMAP have different metadata shapes and need their own paths.
    if !matches!(account.provider, MailProvider::Google) {
        return Ok(HttpResponse::NotImplemented().json(serde_json::json!({
            "message": "Rehydrate is currently Gmail-only. Open a ticket if you need this for Outlook or IMAP accounts.",
            "provider": account.provider.as_db()
        })));
    }

    let Some(refresh_token) = account.usable_refresh_token() else {
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Reconnect the email account first — no usable refresh token on file."
        })));
    };

    let token = refresh_and_persist_email_token(
        pool.get_ref(),
        account.id,
        account.provider,
        refresh_token,
    )
    .await
    .map_err(|e| {
        AppError::Internal(format!(
            "token refresh failed for account {}: {e}",
            account.id
        ))
    })?;

    // Every row is re-fetched rather than guessing which look like stubs; the
    // operation is idempotent.
    let rows = sqlx::query("SELECT gmail_id FROM emails WHERE account_id = $1")
        .bind(account.id)
        .fetch_all(pool.get_ref())
        .await?;

    let gmail_ids: Vec<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("gmail_id").ok())
        .collect();
    let total = gmail_ids.len();

    info!(
        target: "gmail",
        user_id,
        account_id = account.id,
        total,
        "rehydrate: starting",
    );

    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let access_token = Arc::new(token.access_token);
    let mut tasks = FuturesUnordered::new();

    for gmail_id in gmail_ids {
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AppError::Internal(format!("semaphore closed unexpectedly: {e}")))?;
        let token = access_token.clone();
        let pool = pool.get_ref().clone();
        let account_id = account.id;
        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            rehydrate_one(&pool, account_id, &gmail_id, &token).await
        }));
    }

    let mut updated = 0_usize;
    let mut errors = 0_usize;
    while let Some(joined) = tasks.next().await {
        match joined {
            Ok(Ok(true)) => updated += 1,
            Ok(Ok(false)) => {} // no-op (e.g. message was deleted upstream)
            Ok(Err(e)) => {
                warn!(target: "gmail", account_id = account.id, error = ?e, "rehydrate row failed");
                errors += 1;
            }
            Err(e) => {
                warn!(target: "gmail", account_id = account.id, error = ?e, "rehydrate task panicked");
                errors += 1;
            }
        }
    }

    info!(
        target: "gmail",
        user_id,
        account_id = account.id,
        updated,
        errors,
        "rehydrate: complete"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "total": total,
        "updated": updated,
        "errors": errors,
    })))
}

/// Updates one `emails` row from freshly fetched metadata. `Ok(false)` means the
/// message no longer exists upstream.
async fn rehydrate_one(
    pool: &PgPool,
    account_id: i32,
    gmail_id: &str,
    access_token: &str,
) -> Result<bool, anyhow::Error> {
    let header = match fetch_headers_only(access_token, gmail_id).await {
        Ok(h) => h,
        Err(e) => {
            // A 404 means the message was deleted in Gmail since the last sync.
            let msg = format!("{e:?}");
            if msg.contains("404") || msg.to_lowercase().contains("not found") {
                return Ok(false);
            }
            return Err(e);
        }
    };

    let (_msg_id, sender, receiver, subject, _gmail_ts, is_read, labels) = header;

    // An empty subject stores an empty envelope, which the read path treats as
    // NULL and the UI renders as "(No Subject)".
    let (subject_iv, subject_encrypted) = if subject.is_empty() {
        (String::new(), String::new())
    } else {
        match wayve_security::encryption::encrypt(&subject) {
            Ok(envelope) => envelope,
            Err(e) => return Err(anyhow::anyhow!("subject encryption failed: {e}")),
        }
    };

    // Must stay in sync with repo.rs::encrypt_address_for_storage.
    let encrypt_addr = |addr: &str| -> (String, String, String) {
        if addr.is_empty() {
            return (String::new(), String::new(), String::new());
        }
        let (iv, ct) = wayve_security::encryption::encrypt(addr)
            .unwrap_or_else(|_| (String::new(), String::new()));
        let h = wayve_security::encryption::compute_address_hash(addr)
            .ok()
            .flatten()
            .unwrap_or_default();
        (iv, ct, h)
    };
    let (s_iv, s_ct, s_hash) = encrypt_addr(&sender);
    let (r_iv, r_ct, r_hash) = encrypt_addr(&receiver);

    sqlx::query(
        "UPDATE emails SET \
           sender = $1, \
           receiver = $2, \
           subject_iv = $3, \
           subject_encrypted = $4, \
           subject = NULL, \
           sender_iv = NULLIF($5, ''), \
           sender_encrypted = NULLIF($6, ''), \
           sender_hash = NULLIF($7, ''), \
           receiver_iv = NULLIF($8, ''), \
           receiver_encrypted = NULLIF($9, ''), \
           receiver_hash = NULLIF($10, ''), \
           is_read = is_read OR $11, \
           labels = $12 \
         WHERE account_id = $13 AND gmail_id = $14",
    )
    .bind(&sender)
    .bind(&receiver)
    .bind(&subject_iv)
    .bind(&subject_encrypted)
    .bind(&s_iv)
    .bind(&s_ct)
    .bind(&s_hash)
    .bind(&r_iv)
    .bind(&r_ct)
    .bind(&r_hash)
    .bind(is_read)
    .bind(&labels)
    .bind(account_id)
    .bind(gmail_id)
    .execute(pool)
    .await?;

    Ok(true)
}
