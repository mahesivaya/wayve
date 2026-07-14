//! Wrapped-key storage for the BIP-39 recovery flow. The frontend derives an
//! AES-256-GCM wrapping key from the user's mnemonic, encrypts their exported
//! RSA private key with it, and PUTs the opaque envelope here. The server stores
//! it verbatim and cannot decrypt it: the mnemonic never leaves the client.
//!
//! The basic-key endpoints exist only for the one-time migration off the retired
//! server-held escrow. Every endpoint here requires an authenticated session.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, delete, get, put, web};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use tracing::{error, instrument, warn};
use wayve_security::encryption;
use wayve_security::jwt::get_user_id_from_request;

/// The envelope wire format, built by frontend/src/crypto/recovery.ts. All four
/// fields are stored verbatim.
#[derive(Deserialize)]
pub struct PutWrappedKeyInput {
    pub v: i32,
    pub iv: String,
    /// The JSON key is `pub`, a Rust keyword, hence the serde rename.
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

    // No envelope is a normal state, not an error: it triggers the seed-setup modal.
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

    // A correct envelope is 1-2 KB, so anything far larger is a bug or an attempt
    // to fill the disk.
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

/// The password-derived login wrap, in the same `member_login_wrapped_keys` table
/// org members use. This is the auto-unlock-on-a-new-browser path: `login` returns
/// the wrap and the SPA re-derives PBKDF2 from the typed password to unwrap it
/// into IndexedDB. The mnemonic wrap above serves only the forgot-password path.
#[derive(Deserialize)]
pub struct PutLoginWrapInput {
    pub iv: String,
    pub ct: String,
    pub salt: String,
    pub iterations: i32,
}

#[put("/me/login-wrap")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn put_login_wrap(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<PutLoginWrapInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    const MAX_FIELD_LEN: usize = 64 * 1024;
    if body.iv.len() > MAX_FIELD_LEN
        || body.ct.len() > MAX_FIELD_LEN
        || body.salt.len() > MAX_FIELD_LEN
    {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Login-wrap payload too large" })));
    }
    if body.iterations < 100_000 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "PBKDF2 iterations too low" })));
    }

    sqlx::query(
        "INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
         SET iv = EXCLUDED.iv,
             ct = EXCLUDED.ct,
             salt = EXCLUDED.salt,
             iterations = EXCLUDED.iterations,
             updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&body.iv)
    .bind(&body.ct)
    .bind(&body.salt)
    .bind(body.iterations)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::NoContent().finish())
}

#[delete("/me/login-wrap")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_login_wrap(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM member_login_wrapped_keys WHERE user_id = $1")
        .bind(user_id)
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

// Legacy basic-key endpoints, for migration only. Users previously on 'basic' may
// still have a server-held encrypted PKCS8 envelope in
// `users.private_key_encrypted/_iv`. GET serves it so the SPA can re-wrap the key
// under a new mnemonic and PUT that to /me/wrapped-key, then DELETE here to null
// the legacy columns. PUT is permanently 410 Gone.

#[derive(Deserialize)]
pub struct PutBasicKeyInput {
    /// Unused, but kept so the body parses and the SPA sees the 410 rather than
    /// a deserialize error.
    #[allow(dead_code)]
    pub pkcs8: String,
}

/// Resolve the caller's user id, or the error response to return. The basic-key
/// endpoints gate on the presence of `users.private_key_encrypted` rather than
/// on `recovery_mode`.
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

    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT private_key_encrypted, private_key_iv FROM users WHERE id = $1")
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

/// Wipe the legacy server-held PKCS8 envelope, making the mnemonic the only path
/// back in. Idempotent: a no-op on rows that were already migrated.
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

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(get_wrapped_key)
        .service(put_wrapped_key)
        .service(delete_wrapped_key)
        .service(put_login_wrap)
        .service(delete_login_wrap)
        .service(get_basic_key)
        .service(put_basic_key)
        .service(delete_basic_key);
}
