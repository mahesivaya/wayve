//! Wrapped-key storage for the BIP-39 recovery flow, and server-held
//! private-key storage for the "basic" recovery mode.
//!
//! Wrapped-key flow (recovery_mode = 'full' or 'password_only'):
//! The frontend derives an AES-256-GCM wrapping key from the user's 24-word
//! mnemonic (PBKDF2-SHA256, 600,000 iterations), uses it to encrypt the
//! user's exported RSA private key, and POSTs the resulting opaque envelope
//! here. The server stores it verbatim — it cannot decrypt without the
//! mnemonic, which never leaves the client.
//!
//! Basic-key flow (recovery_mode = 'basic'):
//! The frontend POSTs the plaintext PKCS8 private key over TLS. The server
//! encrypts it with the existing `AES_KEY` (via security::encryption) and
//! stores `users.private_key_encrypted/_iv`. On a new device the browser
//! GETs the plaintext back over TLS and saves it to IndexedDB. This is
//! the server-trust tier — DB-only leaks don't expose RSA keys, but the
//! server is trusted to ship plaintext to authenticated clients.
//!
//! Endpoints:
//!   GET    /api/me/wrapped-key  → returns the envelope (404 if missing)
//!   PUT    /api/me/wrapped-key  → upsert (overwrites any prior wrap)
//!   DELETE /api/me/wrapped-key  → remove recovery copy (rare)
//!   GET    /api/me/basic-key    → returns plaintext PKCS8 (basic mode only)
//!   PUT    /api/me/basic-key    → store/replace encrypted private key
//!
//! All five require an authenticated session.

use crate::prelude::*;
use crate::security::encryption;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{HttpRequest, HttpResponse, delete, get, put, web};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use tracing::{error, instrument, warn};

// Wire format reference (built by frontend/src/crypto/recovery.ts):
//   { v: 1, iv: <base64 12B>, pub: <base64 SPKI>, ct: <base64 AES-GCM ct> }
// The server stores all four fields verbatim and cannot decrypt without
// the user's BIP-39 mnemonic, which never leaves the client.

#[derive(Deserialize)]
pub struct PutWrappedKeyInput {
    pub v: i32,
    pub iv: String,
    /// JSON key is `pub` (a Rust keyword), so we rename via serde.
    #[serde(rename = "pub")]
    pub public: String,
    pub ct: String,
}

#[derive(Serialize)]
struct WrappedKeyView {
    v: i32,
    iv: String,
    #[serde(rename = "pub")]
    public: String,
    ct: String,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct WrappedKeyRow {
    v: i32,
    iv: String,
    pub_key: String,
    ct: String,
    updated_at: DateTime<Utc>,
}

#[get("/me/wrapped-key")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn get_wrapped_key(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // password_only users do store an envelope (used by
    // /recover-with-mnemonic to verify mnemonic possession), but its
    // plaintext is random throwaway bytes — useless for client-side
    // key recovery. Return 404 so the SPA doesn't try to unwrap it.
    let recovery_mode: String = sqlx::query_scalar("SELECT recovery_mode FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .unwrap_or_else(|| "full".to_string());

    if recovery_mode == "password_only" {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "No recovery key on file" })));
    }

    let row = sqlx::query_as::<_, WrappedKeyRow>(
        "SELECT v, iv, pub_key, ct, updated_at FROM user_wrapped_keys WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    match row {
        Some(r) => Ok(HttpResponse::Ok().json(WrappedKeyView {
            v: r.v,
            iv: r.iv,
            public: r.pub_key,
            ct: r.ct,
            updated_at: r.updated_at,
        })),
        None => Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "No recovery key on file" }))),
    }
}

#[put("/me/wrapped-key")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn put_wrapped_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<PutWrappedKeyInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // Defensive bounds. A correct envelope is around 1-2 KB; anything
    // significantly larger is either a bug or someone trying to fill our
    // disks. Reject early.
    const MAX_FIELD_LEN: usize = 64 * 1024;
    if body.iv.len() > MAX_FIELD_LEN
        || body.public.len() > MAX_FIELD_LEN
        || body.ct.len() > MAX_FIELD_LEN
    {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Recovery payload too large" })));
    }
    if body.v != 1 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Unsupported envelope version" })));
    }

    sqlx::query(
        r#"
        INSERT INTO user_wrapped_keys (user_id, v, iv, pub_key, ct, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          v = EXCLUDED.v,
          iv = EXCLUDED.iv,
          pub_key = EXCLUDED.pub_key,
          ct = EXCLUDED.ct,
          updated_at = NOW()
        "#,
    )
    .bind(user_id)
    .bind(body.v)
    .bind(&body.iv)
    .bind(&body.public)
    .bind(&body.ct)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::NoContent().finish())
}

#[delete("/me/wrapped-key")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_wrapped_key(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM user_wrapped_keys WHERE user_id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

// =============================================================================
// Basic-mode private-key storage
// =============================================================================
//
// Wire format:
//   PUT  body  { "pkcs8": "<base64 of PKCS8 plaintext>" }
//   GET  body  { "pkcs8": "<base64 of PKCS8 plaintext>" }
//
// The PKCS8 payload is the user's exported RSA-OAEP private key. The
// server encrypts at rest with AES_KEY (security::encryption) and
// re-decrypts only for the authenticated owner. password_only and full
// users are rejected — only `basic` users have opted into server-held
// key escrow.

#[derive(Deserialize)]
pub struct PutBasicKeyInput {
    /// Base64 of the PKCS8 plaintext of the user's RSA-OAEP private key.
    /// Browsers produce this via `crypto.subtle.exportKey("pkcs8", ...)`
    /// and base64-encode it before sending.
    pub pkcs8: String,
}

/// Reject if the caller's `recovery_mode` is not `'basic'`. Returns the
/// resolved (user_id, recovery_mode) for caller convenience.
async fn require_basic_mode(
    req: &HttpRequest,
    pool: &PgPool,
) -> Result<i32, HttpResponse> {
    let user_id = match get_user_id_from_request(req) {
        Some(id) => id,
        None => {
            return Err(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Missing or invalid token" })));
        }
    };
    let mode: Option<String> = sqlx::query_scalar("SELECT recovery_mode FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let mode = mode.unwrap_or_else(|| "full".to_string());
    if mode != "basic" {
        warn!(target: "auth", user_id, recovery_mode = %mode, "basic-key access denied: wrong recovery_mode");
        return Err(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "No basic-mode key on file" })));
    }
    Ok(user_id)
}

#[put("/me/basic-key")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn put_basic_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<PutBasicKeyInput>,
) -> AppResult {
    let user_id = match require_basic_mode(&req, pool.get_ref()).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    // PKCS8 RSA-2048 keys are ~1.2 KB. Reject anything wildly larger so a
    // malformed/empty payload doesn't waste DB space.
    const MAX_PKCS8_B64_LEN: usize = 8 * 1024;
    let trimmed = body.pkcs8.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PKCS8_B64_LEN {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Invalid PKCS8 payload size" })));
    }

    // Decode the b64 PKCS8 once so we never persist invalid base64 (and to
    // catch typos earlier than an unwrap on read). The decoded bytes are
    // what we hand to encrypt_binary; we don't store them.
    let pkcs8_bytes = match base64::engine::general_purpose::STANDARD.decode(trimmed) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "PKCS8 payload is not valid base64" })));
        }
    };

    let (iv_b64, ciphertext) = match encryption::encrypt_binary(&pkcs8_bytes) {
        Ok(pair) => pair,
        Err(e) => {
            error!(target: "auth", user_id, error = ?e, "basic-key encrypt failed");
            return Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Failed to seal basic key" })));
        }
    };
    let ct_b64 = base64::engine::general_purpose::STANDARD.encode(&ciphertext);

    sqlx::query(
        "UPDATE users SET private_key_encrypted = $1, private_key_iv = $2 WHERE id = $3",
    )
    .bind(&ct_b64)
    .bind(&iv_b64)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::NoContent().finish())
}

#[get("/me/basic-key")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn get_basic_key(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match require_basic_mode(&req, pool.get_ref()).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT private_key_encrypted, private_key_iv FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let (ct_b64, iv_b64) = match row {
        Some((Some(ct), Some(iv))) => (ct, iv),
        _ => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "No basic-mode key on file" })));
        }
    };

    let ct_bytes = match base64::engine::general_purpose::STANDARD.decode(&ct_b64) {
        Ok(b) => b,
        Err(_) => {
            error!(target: "auth", user_id, "basic-key ciphertext malformed");
            return Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Stored basic key is corrupted" })));
        }
    };
    let pkcs8 = match encryption::decrypt_binary(&iv_b64, &ct_bytes) {
        Ok(bytes) => bytes,
        Err(err) => {
            error!(target: "auth", user_id, error = ?err, "basic-key decrypt failed");
            return Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Failed to unseal basic key" })));
        }
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "pkcs8": base64::engine::general_purpose::STANDARD.encode(&pkcs8),
    })))
}
