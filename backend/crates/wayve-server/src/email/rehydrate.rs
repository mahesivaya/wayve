//! `POST /api/email/accounts/{id}/rehydrate` — for every row this
//! account owns in `emails`, re-fetch the message metadata from the
//! provider (Gmail today; Outlook is stubbed) and overwrite the
//! stored subject/sender/receiver/labels with the fresh values.
//!
//! Why this exists: the initial IMAP-style sync for some accounts wrote
//! placeholder strings instead of real subjects (every row in the
//! affected account has an 8-character subject ciphertext, suggesting
//! the same short stub on every email). The forward sync only updates
//! a row if a new copy of the message comes in; it won't rewrite
//! already-stored rows on its own. This endpoint is the manual repair
//! path the user runs once per affected account.
//!
//! Caller must be the account owner. Provider must be Google. Rate-
//! limited to 10 concurrent `messages.get` requests so we don't blow
//! Gmail's 250-quota-units/user/sec ceiling (each metadata fetch costs
//! 5 units = 50 calls/sec effective; we cap below that to leave room
//! for other workers).

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

    // Ownership check — the loader returns Err if the account isn't
    // owned by the caller; we surface that as 404 to avoid leaking
    // which account ids exist.
    let account: EmailAccount =
        match load_email_account_for_user(pool.get_ref(), account_id, user_id).await? {
            Some(a) => a,
            None => return Err(AppError::NotFound("email account")),
        };

    // Gmail-only for v1. Outlook + IMAP have their own metadata fetch
    // shapes; add similar paths there when those accounts also need
    // repair.
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

    // Pull the gmail_id of every row we already have. We don't bother
    // filtering "looks like a stub" here — the user explicitly asked
    // for all subjects to be re-imported and the operation is
    // idempotent.
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

/// Fetches one message's metadata and updates the matching `emails`
/// row. Returns `Ok(true)` if the row was updated, `Ok(false)` if the
/// message was missing upstream, `Err` if the fetch or DB write
/// failed.
async fn rehydrate_one(
    pool: &PgPool,
    account_id: i32,
    gmail_id: &str,
    access_token: &str,
) -> Result<bool, anyhow::Error> {
    let header = match fetch_headers_only(access_token, gmail_id).await {
        Ok(h) => h,
        Err(e) => {
            // 404 from Gmail = message no longer exists upstream
            // (deleted in Gmail since we last synced). Treat as no-op.
            let msg = format!("{e:?}");
            if msg.contains("404") || msg.to_lowercase().contains("not found") {
                return Ok(false);
            }
            return Err(e);
        }
    };

    let (_msg_id, sender, receiver, subject, _gmail_ts, is_read, labels) = header;

    // Encrypt the fresh subject. Empty subject → empty envelope (NULL-
    // ish from the read path's perspective; the UI shows "(No
    // Subject)" by convention).
    let (subject_iv, subject_encrypted) = if subject.is_empty() {
        (String::new(), String::new())
    } else {
        match wayve_security::encryption::encrypt(&subject) {
            Ok(envelope) => envelope,
            Err(e) => return Err(anyhow::anyhow!("subject encryption failed: {e}")),
        }
    };

    // Address columns — same envelope shape as repo.rs::encrypt_address_for_storage.
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
