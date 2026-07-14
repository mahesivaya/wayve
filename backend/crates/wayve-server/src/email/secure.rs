//! Secure-send magic link.
//!
//! The sender's browser encrypts the body under a passphrase the recipient gets
//! out-of-band, and uploads only opaque ciphertext, a PBKDF2-wrapped AES key,
//! and a per-message salt. The server never sees the passphrase, derives no key,
//! and cannot decrypt at any point; it emails a magic link, and the recipient
//! enters the passphrase to decrypt in their browser. The fetch route is public
//! and returns 410 once the message expires.

use crate::email::sender::send_mail;
use crate::prelude::*;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use rand::{RngCore, thread_rng};
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

const SECURE_DEFAULT_TTL_DAYS: i64 = 7;
const SECURE_TOKEN_BYTES: usize = 32; // ~43 char base64url, URL-safe.
const SECURE_MAX_CIPHERTEXT_BYTES: usize = 2 * 1024 * 1024; // 2 MiB.
const SECURE_MAX_SUBJECT_BYTES: usize = 1024;

#[derive(Deserialize)]
pub struct SendSecureInput {
    pub recipient_email: String,
    pub subject: String,
    pub ciphertext: String,  // base64 AES-GCM ciphertext of the body
    pub iv: String,          // base64 12-byte AES-GCM nonce
    pub wrapped_key: String, // base64 wrapped AES key (PBKDF2-derived KEK)
    pub salt: String,        // base64 PBKDF2 salt (per-message random)
    /// Defaults to 600,000, matching the recovery flow, and is clamped to a
    /// minimum server-side so a client can't request a weak KEK.
    pub pbkdf2_iterations: Option<i32>,
    /// TTL in days; the server clamps to 1..=30.
    pub ttl_days: Option<i64>,
}

#[derive(Serialize)]
pub struct SecureMessageView {
    pub token: String,
    pub sender_email: String,
    pub subject: String,
    pub ciphertext: String,
    pub iv: String,
    pub wrapped_key: String,
    pub salt: String,
    pub pbkdf2_iterations: i32,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[instrument(target = "gmail", skip(req, data, pool))]
pub async fn send_secure(
    req: HttpRequest,
    data: web::Json<SendSecureInput>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };

    let recipient_email = data.recipient_email.trim();
    let subject = data.subject.trim();
    if recipient_email.is_empty() || !recipient_email.contains('@') {
        return Ok(HttpResponse::BadRequest().body("recipient_email is required and must be valid"));
    }
    if subject.is_empty() || subject.len() > SECURE_MAX_SUBJECT_BYTES {
        return Ok(HttpResponse::BadRequest().body("subject must be 1..=1024 chars"));
    }
    if data.ciphertext.len() > SECURE_MAX_CIPHERTEXT_BYTES {
        return Ok(HttpResponse::BadRequest().body("ciphertext too large"));
    }
    if data.ciphertext.is_empty()
        || data.iv.is_empty()
        || data.wrapped_key.is_empty()
        || data.salt.is_empty()
    {
        return Ok(HttpResponse::BadRequest()
            .body("ciphertext / iv / wrapped_key / salt are all required"));
    }
    let iterations = data.pbkdf2_iterations.unwrap_or(600_000).max(100_000); // never accept a weakly-derived KEK
    let ttl_days = data
        .ttl_days
        .unwrap_or(SECURE_DEFAULT_TTL_DAYS)
        .clamp(1, 30);

    // The token is the bearer credential for the message, so it is 256 bits of
    // randomness. The UNIQUE constraint on `token` is a collision backstop.
    let mut token_bytes = [0u8; SECURE_TOKEN_BYTES];
    thread_rng().fill_bytes(&mut token_bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);

    let expires_at = Utc::now() + Duration::days(ttl_days);

    let sender_email: String =
        match sqlx::query_scalar::<_, Option<String>>("SELECT email FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?
            .flatten()
        {
            Some(addr) => addr,
            None => return Ok(HttpResponse::Unauthorized().body("Sender account not found")),
        };

    sqlx::query(
        r#"
        INSERT INTO secure_messages
            (token, sender_user_id, recipient_email, subject,
             ciphertext, iv, wrapped_key, salt, pbkdf2_iterations, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(&token)
    .bind(user_id)
    .bind(recipient_email)
    .bind(subject)
    .bind(&data.ciphertext)
    .bind(&data.iv)
    .bind(&data.wrapped_key)
    .bind(&data.salt)
    .bind(iterations)
    .bind(expires_at)
    .execute(pool.get_ref())
    .await?;

    // The notification carries only the link and an explainer. No message
    // content may go in it — the whole point is that the server can't read it.
    let frontend = crate::config::frontend_url();
    let link = format!("{frontend}/m/{token}");
    let notification_subject = format!("{sender_email} sent you a secure message");
    let notification_body = format!(
        "{sender_email} sent you an encrypted message on Fluxze.\n\
         \n\
         View it here:\n\
         {link}\n\
         \n\
         You'll need the passphrase {sender_email} shared with you out-of-band\n\
         (Signal, SMS, or in person) to decrypt the message in your browser.\n\
         The link expires in {ttl_days} days.\n\
         \n\
         If you weren't expecting this message, you can ignore this email."
    );

    match send_mail(recipient_email, &notification_subject, &notification_body).await {
        Ok(()) => {
            info!(
                target: "gmail",
                user_id,
                recipient = recipient_email,
                token = %token,
                "secure-send: notification dispatched"
            );
        }
        Err(e) => {
            // The row is already stored, so the link works, but the recipient
            // never received it. Return the link in the 502 so the sender can
            // share it manually rather than lose the message.
            error!(
                target: "gmail",
                user_id,
                recipient = recipient_email,
                error = ?e,
                "secure-send: notification email failed (ciphertext persisted)"
            );
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Secure message stored but notification email failed to send. \
                            Share the link manually if you have it.",
                "token": token,
                "link": link,
            })));
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "token": token,
        "link": link,
        "expires_at": expires_at,
    })))
}

#[instrument(target = "http", skip(pool, path))]
pub async fn get_secure_message(pool: web::Data<PgPool>, path: web::Path<String>) -> AppResult {
    // Deliberately public: recipients are not Wayve users. The token is the
    // bearer credential, and only token plus out-of-band passphrase unlocks the
    // message.
    let token = path.into_inner();
    if token.is_empty() || token.len() > 100 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Invalid or expired link" })));
    }

    let row = sqlx::query(
        r#"
        SELECT s.token, s.ciphertext, s.iv, s.wrapped_key, s.salt,
               s.pbkdf2_iterations, s.subject, s.expires_at, s.created_at,
               u.email AS sender_email
          FROM secure_messages s
          JOIN users u ON u.id = s.sender_user_id
         WHERE s.token = $1
        "#,
    )
    .bind(&token)
    .fetch_optional(pool.get_ref())
    .await?;

    let row = match row {
        Some(r) => r,
        None => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "Invalid or expired link" })));
        }
    };

    let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
    if Utc::now() >= expires_at {
        // 410, not 404, so the UI can distinguish expired from never-existed.
        return Ok(HttpResponse::Gone()
            .json(serde_json::json!({ "message": "This secure message has expired" })));
    }

    // Best-effort: an audit-trail write must not block the recipient's read.
    sqlx::query(
        "UPDATE secure_messages SET opened_at = NOW() \
         WHERE token = $1 AND opened_at IS NULL",
    )
    .bind(&token)
    .execute(pool.get_ref())
    .await
    .ok();

    let view = SecureMessageView {
        token: row.try_get("token")?,
        sender_email: row.try_get("sender_email")?,
        subject: row.try_get("subject")?,
        ciphertext: row.try_get("ciphertext")?,
        iv: row.try_get("iv")?,
        wrapped_key: row.try_get("wrapped_key")?,
        salt: row.try_get("salt")?,
        pbkdf2_iterations: row.try_get("pbkdf2_iterations")?,
        expires_at,
        created_at: row.try_get("created_at")?,
    };

    Ok(HttpResponse::Ok().json(view))
}

#[instrument(target = "gmail", skip(req, pool, path))]
pub async fn revoke_secure_message(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> AppResult {
    // Gated to the original sender, so someone who merely holds the token can't
    // destroy the message.
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };
    let token = path.into_inner();
    let result =
        sqlx::query("DELETE FROM secure_messages WHERE token = $1 AND sender_user_id = $2")
            .bind(&token)
            .bind(user_id)
            .execute(pool.get_ref())
            .await?;
    if result.rows_affected() == 0 {
        warn!(target: "gmail", user_id, token = %token, "revoke: no matching row (wrong sender or already gone)");
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Not found" })));
    }
    Ok(HttpResponse::NoContent().finish())
}
