//! HTTP route for connecting a Yahoo Mail account via app password.
//!
//! Yahoo doesn't have an OAuth dance — the user generates an app password
//! in Yahoo Account Security and submits it directly to us. We verify the
//! credential by running an IMAP LOGIN against imap.mail.yahoo.com:993
//! before persisting; the password is encrypted at rest with AES-256-GCM
//! and stored in `email_accounts.refresh_token` (we reuse the column,
//! since there's no OAuth refresh token to put there for this provider).

use crate::email::account::{
    ConnectedEmailAccount, email_owned_by_other_user, upsert_connected_email_account,
};
use crate::email::oauth_flow::require_external_mailbox_actor;
use crate::email::provider::MailProvider;
use crate::email::yahoo::{encode_app_password, verify_credentials};
use actix_web::{HttpRequest, HttpResponse, Responder, web};
use serde::Deserialize;
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

#[derive(Deserialize)]
pub struct YahooConnectInput {
    pub email: String,
    pub app_password: String,
}

#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn yahoo_connect(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<YahooConnectInput>,
) -> impl Responder {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" }));
        }
    };

    // Reuse the Gmail/Outlook RBAC gate: personal users + organization
    // owners can connect external mailboxes; everyone else uses shared
    // inboxes at /settings/inboxes.
    if let Err(response) = require_external_mailbox_actor(pool.get_ref(), user_id).await {
        return response;
    }

    let email = data.email.trim().to_lowercase();
    let password = data.app_password.trim();
    if email.is_empty() || password.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Email and app password are required"
        }));
    }
    // Yahoo app passwords are 16 lowercase alphanumeric chars (no spaces
    // in the actual credential — the dashboard inserts spaces for
    // readability). We don't enforce the format strictly, but a quick
    // length sanity check catches paste errors before the IMAP roundtrip.
    if password.len() < 8 {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "App password looks too short — paste the value from Yahoo Account Security"
        }));
    }

    // Same anti-duplicate guard as Gmail/Outlook: a given mailbox can be
    // attached to at most one Wayve user (shared inboxes use a separate
    // membership table; this is the per-user case).
    match email_owned_by_other_user(pool.get_ref(), &email, user_id).await {
        Ok(Some(other_user)) => {
            warn!(target: "auth", user_id, other_user, email = %email, "yahoo connect rejected: email already owned");
            return HttpResponse::Conflict().json(serde_json::json!({
                "message": "That email is already connected to another Fluxze account."
            }));
        }
        Ok(None) => {}
        Err(e) => {
            error!(target: "db", error = ?e, "yahoo connect duplicate-check failed");
            return HttpResponse::InternalServerError().finish();
        }
    }

    // Verify the credential via real IMAP LOGIN before we persist. A 4xx
    // here is what the user sees if their app password is wrong/expired.
    if let Err(e) = verify_credentials(&email, password).await {
        warn!(target: "auth", user_id, email = %email, error = ?e, "yahoo IMAP login failed");
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Yahoo rejected those credentials. Double-check the email and app password, then try again."
        }));
    }

    let stored = match encode_app_password(password) {
        Ok(blob) => blob,
        Err(e) => {
            error!(target: "auth", error = ?e, "yahoo credential encrypt failed");
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "message": "Could not securely store credentials. Please try again."
            }));
        }
    };

    let account = ConnectedEmailAccount {
        email: &email,
        user_id,
        provider: MailProvider::Yahoo,
        // No OAuth access token for Yahoo — the IMAP/SMTP credential is
        // the encrypted app password in `refresh_token`. Leave access_token
        // empty so it's obvious from a DB row inspection.
        access_token: "",
        refresh_token: Some(&stored),
        // No OAuth expiry; pin to a far-future timestamp via `expires_in`
        // so the token_expiry column is well-formed. The worker doesn't
        // gate on this for Yahoo (refresh_token decode is the only path).
        expires_in: 60 * 60 * 24 * 365 * 10, // 10 years
    };

    let account_id = match upsert_connected_email_account(pool.get_ref(), account).await {
        Ok(id) => id,
        Err(e) => {
            error!(target: "db", error = ?e, "yahoo account upsert failed");
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "message": "Could not save the connected account."
            }));
        }
    };

    info!(target: "auth", user_id, account_id, "yahoo account connected");

    // Kick off an initial sync in the background so the inbox starts
    // populating right away. The standard sync worker picks this account
    // up on its next tick too, but the immediate fire-and-forget shaves
    // 30s off the user's first impression.
    let pool_clone = pool.get_ref().clone();
    let email_clone = email.clone();
    let password_clone = password.to_string();
    actix_web::rt::spawn(async move {
        // The canonical "first-sync" path used by Gmail/Outlook callbacks
        // is `sync_account_recent`, but it's hard-wired to the OAuth
        // refresh-token detour. For Yahoo we already have the plaintext
        // password in scope, so we call the provider's IMAP sync directly.
        if let Err(e) = crate::email::yahoo::sync_yahoo_account(
            &pool_clone,
            account_id,
            &email_clone,
            &password_clone,
        )
        .await
        {
            warn!(target: "worker", account_id, error = ?e, "initial yahoo sync failed");
        }
    });

    HttpResponse::Created().json(serde_json::json!({
        "id": account_id,
        "email": email,
        "provider": "yahoo"
    }))
}
