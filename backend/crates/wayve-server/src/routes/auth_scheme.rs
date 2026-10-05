//! Login credential schemes, and `POST /api/auth/prelogin`.
//!
//! Scheme 1 (legacy): `users.password` is bcrypt(raw password), so the server
//! sees the password at every login. Scheme 2: the browser derives
//! `auth_key = PBKDF2-SHA256("wayve-auth-v1:" + password, auth_salt, 600k)` and
//! sends only that; `users.password` is bcrypt(auth_key). The password also
//! derives the key that unlocks the user's private key (the login wrap, with its
//! own salt), so under scheme 2 the server never holds anything that unlocks it.
//!
//! Every password-setting endpoint accepts either a browser-derived
//! [`DerivedCredential`] (stored as scheme 2) or a legacy raw password (scheme
//! 1, kept for scripts, seeds and API clients). Scheme-1 users upgrade on their
//! next login.

use crate::prelude::*;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing::{instrument, warn};
use wayve_security::password::hash_password;

pub(crate) const SCHEME_LEGACY: i16 = 1;
pub(crate) const SCHEME_AUTH_KEY: i16 = 2;

/// PBKDF2 output and salt sizes the browser uses (`frontend/src/auth/authKey.ts`).
const AUTH_KEY_BYTES: usize = 32;
const AUTH_SALT_BYTES: usize = 16;

/// A credential the browser derived from the password; the password itself
/// never reaches the server.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DerivedCredential {
    pub auth_salt: String,
    pub auth_key: String,
}

/// What to write into `users.password` / `auth_scheme` / `auth_salt`.
pub(crate) struct StoredCredential {
    pub hash: String,
    pub scheme: i16,
    pub salt: Option<String>,
}

fn decodes_to(b64: &str, len: usize) -> bool {
    B64.decode(b64).is_ok_and(|bytes| bytes.len() == len)
}

/// Rejects anything that isn't a well-formed browser derivation, so a raw
/// password can't be smuggled in as an `auth_key` and stored as scheme 2.
pub(crate) fn validate_derived(cred: &DerivedCredential) -> std::result::Result<(), AppError> {
    if !decodes_to(&cred.auth_salt, AUTH_SALT_BYTES) || !decodes_to(&cred.auth_key, AUTH_KEY_BYTES)
    {
        return Err(AppError::BadRequest("Malformed auth key or salt".into()));
    }
    Ok(())
}

/// Cheap validation of a new credential before any token, envelope or current-
/// password check, so a malformed request fails fast without spending a bcrypt.
/// `min_legacy_len` matches the `store_credential` call that follows.
pub(crate) fn precheck_new_credential(
    derived: Option<&DerivedCredential>,
    legacy_password: Option<&str>,
    min_legacy_len: usize,
) -> std::result::Result<(), AppError> {
    match (derived, legacy_password) {
        (Some(cred), _) => validate_derived(cred),
        (None, Some(pw)) if pw.len() >= min_legacy_len => Ok(()),
        _ => Err(AppError::BadRequest(format!(
            "Password must be at least {min_legacy_len} characters"
        ))),
    }
}

/// Hash a new credential for storage: the derived one when present (scheme 2),
/// otherwise the legacy raw password (scheme 1). `min_legacy_len` is the
/// endpoint's password-length rule, which only the legacy path can enforce —
/// for scheme 2 the browser checks it before deriving.
pub(crate) async fn store_credential(
    derived: Option<&DerivedCredential>,
    legacy_password: Option<&str>,
    min_legacy_len: usize,
) -> std::result::Result<StoredCredential, AppError> {
    if let Some(cred) = derived {
        validate_derived(cred)?;
        return Ok(StoredCredential {
            hash: hash_password(&cred.auth_key).await?,
            scheme: SCHEME_AUTH_KEY,
            salt: Some(cred.auth_salt.clone()),
        });
    }
    match legacy_password {
        Some(pw) if pw.len() >= min_legacy_len => Ok(StoredCredential {
            hash: hash_password(pw).await?,
            scheme: SCHEME_LEGACY,
            salt: None,
        }),
        Some(_) => Err(AppError::BadRequest(format!(
            "Password must be at least {min_legacy_len} characters"
        ))),
        None => Err(AppError::BadRequest("A password is required".into())),
    }
}

/// Write a new credential onto an existing user.
pub(crate) async fn set_user_credential<'e, E>(
    executor: E,
    user_id: i32,
    cred: &StoredCredential,
) -> std::result::Result<(), sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query("UPDATE users SET password = $1, auth_scheme = $2, auth_salt = $3 WHERE id = $4")
        .bind(&cred.hash)
        .bind(cred.scheme)
        .bind(&cred.salt)
        .bind(user_id)
        .execute(executor)
        .await?;
    Ok(())
}

/// Deterministic stand-in salt for an identifier with no scheme-2 account, so
/// prelogin answers the same shape for "no such user" as for a real one.
pub(crate) fn fake_salt(identifier: &str) -> String {
    let secret = crate::config::jwt_secret();
    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        // HMAC accepts keys of any length; this arm is unreachable in practice.
        Err(_) => return B64.encode([0u8; AUTH_SALT_BYTES]),
    };
    mac.update(b"wayve-prelogin-salt-v1:");
    mac.update(identifier.as_bytes());
    let digest = mac.finalize().into_bytes();
    B64.encode(&digest[..AUTH_SALT_BYTES])
}

#[derive(Deserialize)]
pub struct PreloginInput {
    pub email: String,
}

#[derive(Serialize)]
pub struct PreloginResponse {
    pub scheme: i16,
    pub auth_salt: Option<String>,
}

/// Tells the browser how to send this account's credential: scheme 2 with the
/// salt to derive `auth_key`, or scheme 1 (send the password once, plus an
/// upgrade). Unknown identifiers get scheme 2 and a deterministic fake salt.
#[post("/auth/prelogin")]
#[instrument(target = "auth", skip(pool, data))]
pub async fn prelogin(pool: web::Data<PgPool>, data: web::Json<PreloginInput>) -> AppResult {
    // Must match `login`'s identifier normalization and lookup exactly.
    let identifier = data.email.trim().to_lowercase();
    let row: Option<(i16, Option<String>, bool)> = sqlx::query_as(
        "SELECT auth_scheme, auth_salt, password IS NOT NULL FROM users \
         WHERE email = $1 OR lower(username) = $1",
    )
    .bind(&identifier)
    .fetch_optional(pool.get_ref())
    .await?;

    let fake = || PreloginResponse {
        scheme: SCHEME_AUTH_KEY,
        auth_salt: Some(fake_salt(&identifier)),
    };
    let response = match row {
        // A password-less (Google/SSO) account must never be told to send a raw
        // password, so it answers exactly like an unknown identifier.
        None | Some((_, _, false)) => fake(),
        Some((SCHEME_AUTH_KEY, Some(salt), true)) => PreloginResponse {
            scheme: SCHEME_AUTH_KEY,
            auth_salt: Some(salt),
        },
        Some((SCHEME_AUTH_KEY, None, true)) => {
            warn!(target: "auth", "prelogin: scheme-2 account without auth_salt");
            fake()
        }
        Some((_, _, true)) => PreloginResponse {
            scheme: SCHEME_LEGACY,
            auth_salt: None,
        },
    };
    Ok(HttpResponse::Ok().json(response))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(prelogin);
}
