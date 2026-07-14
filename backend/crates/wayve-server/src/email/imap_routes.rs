//! HTTP routes for connecting a generic IMAP/SMTP mailbox, meaning any
//! custom-domain address not on Google or Microsoft. The connect wizard walks
//! autodiscover, then test-login, then connect.
//!
//! The IMAP/SMTP password is encrypted at rest in `email_accounts.refresh_token`
//! as `<iv>.<cipher>`; host, port, and security go in the
//! `imap_*`/`smtp_*`/`mail_security` columns.

use crate::email::account::{
    ConnectedEmailAccount, email_owned_by_other_user, invalidate_email_account_cache,
    upsert_connected_email_account,
};
use crate::email::imap::{encode_secret, sync_imap_account, verify_credentials};
use crate::email::oauth_flow::require_external_mailbox_actor;
use crate::email::provider::MailProvider;
use crate::email::provider_lookup::{mx_provider, provider_for_known_domain};
use actix_web::{HttpRequest, HttpResponse, Responder, web};
use serde::Deserialize;
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

fn domain_of(email: &str) -> Option<String> {
    match email.split_once('@') {
        Some((local, d)) if !local.is_empty() && !d.is_empty() && d.contains('.') => {
            Some(d.to_string())
        }
        _ => None,
    }
}

/// Best-effort IMAP/SMTP settings for a domain we don't have OAuth for. A small
/// table of common providers, else the conventional `imap.<domain>` /
/// `smtp.<domain>` on implicit-TLS ports. The connect form lets the user edit
/// these, and test-login validates before anything is saved.
fn imap_guess(domain: &str) -> (String, i32, String, i32) {
    match domain {
        "zoho.com" => ("imap.zoho.com".into(), 993, "smtp.zoho.com".into(), 465),
        "fastmail.com" | "fastmail.fm" => (
            "imap.fastmail.com".into(),
            993,
            "smtp.fastmail.com".into(),
            465,
        ),
        "icloud.com" | "me.com" | "mac.com" => (
            "imap.mail.me.com".into(),
            993,
            "smtp.mail.me.com".into(),
            587,
        ),
        _ => (format!("imap.{domain}"), 993, format!("smtp.{domain}"), 465),
    }
}

#[derive(Deserialize)]
pub struct AutodiscoverInput {
    pub email: String,
}

#[instrument(target = "email", skip(req, body), fields(email = %body.email))]
pub async fn imap_autodiscover(
    req: HttpRequest,
    body: web::Json<AutodiscoverInput>,
) -> impl Responder {
    if get_user_id_from_request(&req).is_none() {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    }
    let email = body.email.trim().to_lowercase();
    let Some(domain) = domain_of(&email) else {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Enter a valid email address" }));
    };

    // Steer Google/Microsoft domains to the existing OAuth connectors.
    let oauth = match provider_for_known_domain(&domain) {
        Some(p) => Some(p),
        None => mx_provider(&domain).await,
    };
    if let Some(p) = oauth {
        let hint = if p == "outlook" {
            "microsoft"
        } else {
            "google"
        };
        return HttpResponse::Ok().json(serde_json::json!({ "use_oauth": hint }));
    }

    let (imap_host, imap_port, smtp_host, smtp_port) = imap_guess(&domain);
    HttpResponse::Ok().json(serde_json::json!({
        "imap_host": imap_host,
        "imap_port": imap_port,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "security": "ssl",
    }))
}

#[derive(Deserialize)]
pub struct TestLoginInput {
    pub email: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub password: String,
}

#[instrument(target = "auth", skip(req, body), fields(email = %body.email))]
pub async fn imap_test_login(req: HttpRequest, body: web::Json<TestLoginInput>) -> impl Responder {
    if get_user_id_from_request(&req).is_none() {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    }
    let email = body.email.trim().to_lowercase();
    let host = body.imap_host.trim();
    let password = body.password.trim();
    if email.is_empty() || host.is_empty() || password.is_empty() {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Email, IMAP host and password are required" }));
    }
    match verify_credentials(host, body.imap_port, &email, password).await {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({ "ok": true })),
        Err(e) => {
            warn!(target: "auth", email = %email, host, error = ?e, "imap test-login failed");
            HttpResponse::BadRequest().json(serde_json::json!({
                "message": "Couldn't sign in. Check the email, password (use an app password), and server settings."
            }))
        }
    }
}

#[derive(Deserialize)]
pub struct ConnectInput {
    pub email: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub security: Option<String>,
    pub password: String,
}

#[instrument(target = "auth", skip(req, pool, body), fields(email = %body.email))]
pub async fn imap_connect(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ConnectInput>,
) -> impl Responder {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" }));
        }
    };

    // Same RBAC gate as the OAuth connectors: personal users + org owners may
    // attach external mailboxes; everyone else uses shared inboxes.
    if let Err(response) = require_external_mailbox_actor(pool.get_ref(), user_id).await {
        return response;
    }

    let email = body.email.trim().to_lowercase();
    let host = body.imap_host.trim().to_string();
    let smtp_host = body.smtp_host.trim().to_string();
    let password = body.password.trim().to_string();
    let security = match body.security.as_deref().map(str::trim) {
        Some("starttls") => "starttls",
        _ => "ssl",
    };
    if email.is_empty() || host.is_empty() || smtp_host.is_empty() || password.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Email, IMAP host, SMTP host and password are required"
        }));
    }

    // A mailbox belongs to at most one (non-shared) Wayve user.
    match email_owned_by_other_user(pool.get_ref(), &email, user_id).await {
        Ok(Some(other)) => {
            warn!(target: "auth", user_id, other, email = %email, "imap connect rejected: already owned");
            return HttpResponse::Conflict().json(serde_json::json!({
                "message": "That email is already connected to another Fluxze account."
            }));
        }
        Ok(None) => {}
        Err(e) => {
            error!(target: "db", error = ?e, "imap connect duplicate-check failed");
            return HttpResponse::InternalServerError().finish();
        }
    }

    if let Err(e) = verify_credentials(&host, body.imap_port, &email, &password).await {
        warn!(target: "auth", user_id, email = %email, error = ?e, "imap connect verify failed");
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Couldn't sign in with those settings. Check the password (use an app password) and server details."
        }));
    }

    let stored = match encode_secret(&password) {
        Ok(blob) => blob,
        Err(e) => {
            error!(target: "auth", error = ?e, "imap credential encrypt failed");
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "message": "Could not securely store credentials. Please try again."
            }));
        }
    };

    let account = ConnectedEmailAccount {
        email: &email,
        user_id,
        provider: MailProvider::Imap,
        access_token: "",
        refresh_token: Some(&stored),
        expires_in: 60 * 60 * 24 * 365 * 10, // 10y; not used for IMAP
    };
    let account_id = match upsert_connected_email_account(pool.get_ref(), account).await {
        Ok(id) => id,
        Err(e) => {
            error!(target: "db", error = ?e, "imap account upsert failed");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Could not save the connected account." }));
        }
    };

    // Separate UPDATE so the shared upsert helper stays provider-agnostic.
    if let Err(e) = sqlx::query(
        "UPDATE email_accounts \
         SET imap_host = $1, imap_port = $2, smtp_host = $3, smtp_port = $4, mail_security = $5 \
         WHERE id = $6",
    )
    .bind(&host)
    .bind(body.imap_port as i32)
    .bind(&smtp_host)
    .bind(body.smtp_port as i32)
    .bind(security)
    .bind(account_id)
    .execute(pool.get_ref())
    .await
    {
        error!(target: "db", account_id, error = ?e, "imap settings update failed");
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({ "message": "Could not save the connection settings." }));
    }
    invalidate_email_account_cache(account_id).await;

    info!(target: "auth", user_id, account_id, "imap account connected");

    // Fill the inbox immediately; the worker would otherwise wait a tick.
    let pool_clone = pool.get_ref().clone();
    let email_clone = email.clone();
    let imap_port = body.imap_port;
    actix_web::rt::spawn(async move {
        if let Err(e) = sync_imap_account(
            &pool_clone,
            account_id,
            &host,
            imap_port,
            &email_clone,
            &password,
        )
        .await
        {
            warn!(target: "worker", account_id, error = ?e, "initial imap sync failed");
        }
    });

    HttpResponse::Created().json(serde_json::json!({
        "id": account_id,
        "email": email,
        "provider": "imap"
    }))
}

#[cfg(test)]
mod tests {
    use super::{domain_of, imap_guess};

    #[test]
    fn domain_parsing() {
        assert_eq!(
            domain_of("owner@company.com").as_deref(),
            Some("company.com")
        );
        assert_eq!(domain_of("bad-email"), None);
        assert_eq!(domain_of("@nope.com"), None);
        assert_eq!(domain_of("a@b"), None); // no dot in domain
    }

    #[test]
    fn guess_falls_back_to_conventional_hosts() {
        let (ih, ip, sh, sp) = imap_guess("acme.com");
        assert_eq!(ih, "imap.acme.com");
        assert_eq!(ip, 993);
        assert_eq!(sh, "smtp.acme.com");
        assert_eq!(sp, 465);
    }

    #[test]
    fn guess_uses_known_provider_hosts() {
        let (ih, _ip, sh, _sp) = imap_guess("zoho.com");
        assert_eq!(ih, "imap.zoho.com");
        assert_eq!(sh, "smtp.zoho.com");
    }
}
