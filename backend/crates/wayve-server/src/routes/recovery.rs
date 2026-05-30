//! Wrapped-key storage for the BIP-39 recovery flow (Plan A: this is
//! the only flow). The frontend derives an AES-256-GCM wrapping key
//! from the user's 24-word mnemonic (PBKDF2-SHA256, 600,000 iterations),
//! uses it to encrypt the user's exported RSA private key, and PUTs the
//! resulting opaque envelope here. The server stores it verbatim — it
//! cannot decrypt without the mnemonic, which never leaves the client.
//!
//! Legacy basic-key endpoints stay only for the one-time migration:
//! existing users who were on `recovery_mode = 'basic'` had a server-
//! held AES-GCM(AES_KEY)-wrapped PKCS8 envelope in
//! `users.private_key_encrypted/_iv`. On their next login the SPA
//! pulls that via GET /me/basic-key (so even a fresh-device user can
//! recover the RSA key), wraps it under a brand-new mnemonic, PUTs
//! the resulting envelope to /me/wrapped-key, then calls DELETE
//! /me/basic-key to wipe the server-held copy. From that point on the
//! mnemonic is the only path back in. PUT /me/basic-key is a 410 Gone
//! — no new basic-key uploads are accepted under Plan A.
//!
//! Endpoints:
//!   GET    /api/me/wrapped-key  → returns the envelope (404 if missing)
//!   PUT    /api/me/wrapped-key  → upsert (overwrites any prior wrap)
//!   DELETE /api/me/wrapped-key  → remove recovery copy (rare)
//!   GET    /api/me/basic-key    → migration only: returns plaintext PKCS8 while legacy row exists
//!   PUT    /api/me/basic-key    → 410 Gone (basic mode retired)
//!   DELETE /api/me/basic-key    → clear legacy server-held PKCS8 after migration
//!
//! All five require an authenticated session.

use crate::prelude::*;
use wayve_security::encryption;
use wayve_security::jwt::get_user_id_from_request;
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

    // Plan A: only 'full' exists, so no per-mode short-circuit. Either
    // there is an envelope or there isn't; both are normal states for
    // a logged-in user (the latter triggers the seed-setup modal).
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
// Legacy basic-key endpoints — migration only
// =============================================================================
//
// In Plan A every user is on `recovery_mode = 'full'`. Existing users
// who were previously on 'basic' may still have a server-held AES-GCM
// (AES_KEY)-encrypted PKCS8 envelope in `users.private_key_encrypted/_iv`.
// GET serves that envelope so the SPA can recover the RSA private key
// on a fresh device, wrap it under a brand-new mnemonic, and PUT the
// wrapped envelope to /me/wrapped-key. The SPA then calls DELETE
// /me/basic-key, which nulls out the legacy columns — making the
// mnemonic the only path back in from that point on.
//
// PUT is permanently retired (410 Gone) — no new basic-key uploads.

#[derive(Deserialize)]
pub struct PutBasicKeyInput {
    /// Unused under Plan A — kept so the serde body parse succeeds and
    /// the 410 message is what the SPA sees, not a 400 deserialize error.
    #[allow(dead_code)]
    pub pkcs8: String,
}

/// Resolve the caller's user_id, returning the matching error response
/// on missing/invalid token. The legacy basic-key endpoints don't gate
/// on `recovery_mode` (it's always 'full' now) — they gate on the
/// presence of `users.private_key_encrypted`.
fn require_authed_user(req: &HttpRequest) -> Result<i32, HttpResponse> {
    get_user_id_from_request(req).ok_or_else(|| {
        HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Missing or invalid token" }))
    })
}

#[put("/me/basic-key")]
#[instrument(target = "auth", skip(req, _body))]
pub async fn put_basic_key(
    req: HttpRequest,
    _pool: web::Data<PgPool>,
    _body: web::Json<PutBasicKeyInput>,
) -> AppResult {
    if let Some(user_id) = get_user_id_from_request(&req) {
        warn!(
            target: "auth",
            user_id,
            "basic-key PUT rejected: server-held key escrow retired under Plan A"
        );
    }
    Ok(HttpResponse::Gone().json(serde_json::json!({
        "message": "Server-held key escrow has been retired. Wrap your private key with your 24-word recovery phrase and PUT /api/me/wrapped-key instead."
    })))
}

#[get("/me/basic-key")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn get_basic_key(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match require_authed_user(&req) {
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
                .json(serde_json::json!({ "message": "No legacy basic-mode key on file" })));
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

/// Wipe the legacy server-held PKCS8 envelope. Called by the SPA right
/// after a successful migration upload to /me/wrapped-key, so the
/// mnemonic becomes the only path back in. Idempotent: no-op on rows
/// that have already been migrated.
#[delete("/me/basic-key")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_basic_key(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match require_authed_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    sqlx::query(
        "UPDATE users SET private_key_encrypted = NULL, private_key_iv = NULL WHERE id = $1",
    )
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;
    Ok(HttpResponse::NoContent().finish())
}
