//! `POST /api/email/wake` — the user opened the inbox, so sync their accounts
//! now rather than waiting for the worker's next tick.
//!
//! The worker's adaptive schedule (`email/sync.rs::interval_for_age`) defers
//! quiet accounts up to 30 minutes, so without this a user would wait that long
//! for new mail to surface. The handler spawns a fire-and-forget sync per
//! account and returns 202; it does not touch the worker's schedule, and a
//! racing tick is harmless because the row upserts are idempotent.

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

    let accounts = load_user_email_accounts_for_older_sync(pool.get_ref(), user_id, None).await?;
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

    Ok(HttpResponse::Accepted().finish())
}
