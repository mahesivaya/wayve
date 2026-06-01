//! `POST /api/email/wake` — the user just opened the inbox; sync all
//! their email accounts NOW instead of waiting for the next scheduled
//! tick from the background sync worker.
//!
//! Why this exists: the sync worker uses an adaptive per-account
//! schedule (`email/sync.rs::interval_for_age`) that defers quiet
//! accounts up to 5 minutes (COOL) or 30 minutes (COLD). A user
//! sitting on the inbox after a quiet stretch would otherwise wait
//! that long for the first new mail to surface. The wake endpoint
//! kicks off a fire-and-forget one-shot sync for each of the caller's
//! accounts so the next frontend poll picks up anything new.
//!
//! The endpoint is intentionally cheap on the request path:
//! authentication, account load, fan-out `tokio::spawn`, return 202.
//! The actual sync work happens off the request path. The worker's
//! schedule is not touched — it continues on its own cadence; if a
//! tick fires for the same account right after this handler spawned a
//! sync, the second sync is a no-op (Gmail's `historyId` advance is
//! the only thing that changes anything, and our row UPSERTs are
//! idempotent).

use crate::email::account::load_user_email_accounts_for_older_sync;
use crate::email::sync::sync_one_account;
use crate::error::{AppError, AppResult};
use actix_web::{HttpRequest, HttpResponse, post, web};
use sqlx::PgPool;
use tracing::{info, instrument};
use wayve_security::jwt::get_user_id_from_request;

#[post("/email/wake")]
#[instrument(target = "gmail", skip(req, pool))]
pub async fn wake_user_accounts(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // Reuse the existing per-user account loader — it already pulls
    // every active mailbox the caller owns (Gmail + Outlook + future
    // providers) without leaking other tenants.
    let accounts =
        load_user_email_accounts_for_older_sync(pool.get_ref(), user_id, None).await?;
    if accounts.is_empty() {
        return Ok(HttpResponse::NoContent().finish());
    }

    let count = accounts.len();
    info!(target: "gmail", user_id, count, "user-triggered wake sync");
    for account in accounts {
        let pool = pool.get_ref().clone();
        tokio::spawn(async move {
            sync_one_account(&pool, account).await;
        });
    }

    // 202 Accepted — the work is queued. The frontend's next inbox
    // poll (≤60 s away by default) will see whatever the sync surfaced.
    Ok(HttpResponse::Accepted().finish())
}
