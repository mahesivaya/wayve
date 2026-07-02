use crate::prelude::*;

use crate::email::sender::send_mail;
use crate::models::auth::{
    ForgotInput, LoginInput, LoginResponse, MemberLoginWrap, RegisterInput,
    ResendVerificationInput, ResetInput, VerifyEmailInput,
};
use crate::models::message::MessageResponse;
use crate::models::user::User;
use crate::organization;
use rand::RngCore;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::{
    auth_cookie, create_jwt, create_jwt_for_account_with_max_exp, expired_auth_cookie,
    get_user_id_from_request,
};
use wayve_security::password::{hash_password, verify_password};

const RESET_TTL_MINUTES: i64 = 30;
const CODE_TTL_MINUTES: i64 = 15;
const MAX_VERIFY_ATTEMPTS: i32 = 5;
const DUMMY_PASSWORD_HASH: &str = "$2b$12$BeUHqArduWoNmhYKnepJYeYTQdhF/XcdcGFHaxiz0/H3JJUbHyLGe";

/// A 6-digit numeric verification code (zero-padded), from the OS CSPRNG.
fn random_code() -> String {
    use rand::Rng;
    format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000u32))
}

/// Issue a fresh 6-digit email-verification code and email it. Any prior unused
/// codes for the user are invalidated so only the newest is valid. Shared by
/// `/register` and `/resend-verification`.
async fn issue_verification_code_and_email(
    pool: &PgPool,
    user_id: i32,
    email: &str,
) -> std::result::Result<(), AppError> {
    // Keep only the newest code valid.
    sqlx::query(
        "UPDATE email_verification_tokens SET used_at = NOW() \
         WHERE user_id = $1 AND used_at IS NULL",
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    let code = random_code();
    let expires_at = chrono::Utc::now() + chrono::Duration::minutes(CODE_TTL_MINUTES);
    sqlx::query(
        "INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(&code)
    .bind(expires_at)
    .execute(pool)
    .await?;

    let body = format!(
        "Hi,\n\nWelcome to Fluxze! Your email verification code is:\n\n    {code}\n\n\
         Enter it in the app within {CODE_TTL_MINUTES} minutes to activate your account.\n\
         If you didn't create a Fluxze account, you can safely ignore this email.\n"
    );
    send_mail(email, "Your Fluxze verification code", &body)
        .await
        .map_err(|e| AppError::Internal(format!("verification email send: {e}")))?;
    Ok(())
}

#[post("/register")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn register(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<RegisterInput>,
) -> AppResult {
    info!(target: "auth", "register attempt");

    if data.password != data.confirm_password {
        warn!(target: "auth", "register rejected: password mismatch");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Passwords do not match" })));
    }

    // Plan A: every new signup lands on 'full'. The legacy 'basic' and
    // 'password_only' values are no longer accepted — any client still
    // sending them is silently coerced to 'full' rather than rejected
    // outright, because the user's intent ("create an account") is
    // unchanged and the constraint will reject anything else at the
    // DB layer anyway.
    if let Some(requested) = data.recovery_mode.as_deref()
        && requested != "full"
    {
        warn!(
            target: "auth",
            recovery_mode = requested,
            "register: ignoring legacy recovery_mode; coercing to 'full'"
        );
    }
    let recovery_mode = "full";

    let hashed = hash_password(&data.password).await?;

    let result = sqlx::query(
        "INSERT INTO users (email, password, recovery_mode, email_verified) \
         VALUES ($1, $2, $3, false) RETURNING id",
    )
    .bind(&data.email)
    .bind(&hashed)
    .bind(recovery_mode)
    .fetch_one(pool.get_ref())
    .await;

    match result {
        Ok(row) => {
            let user_id: i32 = row.get("id");
            info!(target: "auth", user_id, email = %data.email, provider = "local", "user registered (pending email verification)");
            // No auto-login: the account stays unverified (and login is blocked)
            // until the user clicks the emailed link. Record a register event
            // rather than a login.
            crate::audit::record_action(
                pool.get_ref(),
                &req,
                crate::audit::AuditEvent {
                    actor_user_id: user_id,
                    action: "register",
                    resource_type: "account",
                    resource_id: None,
                    metadata: Some(serde_json::json!({
                        "method": "password",
                        "verification_required": true,
                    })),
                },
            )
            .await;
            match issue_verification_code_and_email(pool.get_ref(), user_id, &data.email).await {
                Ok(()) => Ok(HttpResponse::Ok().json(serde_json::json!({
                    "verification_required": true,
                    "message": "Check your email to verify your account."
                }))),
                Err(e) => {
                    error!(target: "auth", user_id, error = ?e, "verification email failed at register");
                    // The account exists; the user can trigger a resend.
                    Ok(HttpResponse::Ok().json(serde_json::json!({
                        "verification_required": true,
                        "email_send_failed": true,
                        "message": "Account created, but we couldn't send the verification email. Please use Resend."
                    })))
                }
            }
        }

        Err(e) => {
            if e.to_string().contains("duplicate key") {
                warn!("Register rejected (already exists): {}", data.email);
                Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "User already exists" })))
            } else {
                Err(AppError::Db(e))
            }
        }
    }
}

#[post("/login")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub(crate) async fn login(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<LoginInput>,
) -> AppResult {
    info!(target: "auth", "login attempt");

    // Accept either the email or the username as the identifier. Admin-created
    // users (platform/org "create user") are shown an email + temp password,
    // but the derived username is globally unique too — so a person entering
    // the username should still get in. Normalize (trim + lowercase) so a
    // stray space or different casing doesn't read as wrong credentials;
    // emails are stored lowercased and usernames are matched case-insensitively.
    let identifier = data.email.trim().to_lowercase();
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, password, account_type, password_valid_until \
         FROM users WHERE email = $1 OR lower(username) = $1",
    )
    .bind(&identifier)
    .fetch_optional(pool.get_ref())
    .await?;

    let user = match user {
        Some(user) => user,
        None => {
            // Burn the same bcrypt cost as a real verify so the unknown-email
            // path doesn't return faster than a wrong-password path. Result
            // intentionally discarded.
            let _ = verify_password(&data.password, DUMMY_PASSWORD_HASH).await;
            warn!("Invalid login attempt: {}", data.email);
            crate::audit::record_login_failure(
                pool.get_ref(),
                &req,
                &data.email,
                "unknown_email",
                None,
            )
            .await;
            return Ok(HttpResponse::Unauthorized().json(MessageResponse {
                message: "Invalid credentials".to_string(),
            }));
        }
    };

    // Google-signup users have no password — guide them to the right flow.
    let stored_password = match &user.password {
        Some(p) => p,
        None => {
            warn!("Password login rejected for Google account: {}", data.email);
            crate::audit::record_login_failure(
                pool.get_ref(),
                &req,
                &data.email,
                "google_account",
                Some(user.id),
            )
            .await;
            return Ok(HttpResponse::Unauthorized().json(MessageResponse {
                message: "Use 'Sign in with Google' for this account".to_string(),
            }));
        }
    };

    let valid = verify_password(&data.password, stored_password).await?;

    if !valid {
        warn!("Invalid login attempt: {}", data.email);
        crate::audit::record_login_failure(
            pool.get_ref(),
            &req,
            &data.email,
            "bad_password",
            Some(user.id),
        )
        .await;
        return Ok(HttpResponse::Unauthorized().json(MessageResponse {
            message: "Invalid credentials".to_string(),
        }));
    }

    // Short-lived (e.g. guest) accounts carry a hard expiry on the
    // password itself. Refuse login once past that timestamp — bcrypt
    // verify succeeding is not enough on its own. We answer with the
    // generic "Invalid credentials" message to avoid leaking whether
    // an account exists vs has expired.
    if let Some(valid_until) = user.password_valid_until
        && chrono::Utc::now() > valid_until
    {
        warn!(
            target: "auth",
            email = %data.email,
            "Expired credential login attempt (password_valid_until={})",
            valid_until,
        );
        crate::audit::record_login_failure(
            pool.get_ref(),
            &req,
            &data.email,
            "expired_credential",
            Some(user.id),
        )
        .await;
        return Ok(HttpResponse::Unauthorized().json(MessageResponse {
            message: "Invalid credentials".to_string(),
        }));
    }

    // Email-verification gate: local password accounts must confirm their email
    // before the first login. OAuth/SCIM/business + all pre-existing accounts
    // are `email_verified = true` (column default), so they're unaffected.
    let (auth_provider, email_verified): (String, bool) =
        sqlx::query_as("SELECT auth_provider, email_verified FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(pool.get_ref())
            .await?;
    if auth_provider == "local" && !email_verified {
        warn!(target: "auth", email = %data.email, "login blocked: email not verified");
        crate::audit::record_login_failure(
            pool.get_ref(),
            &req,
            &data.email,
            "email_unverified",
            Some(user.id),
        )
        .await;
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "email_unverified",
            "message": "Please verify your email before logging in. Check your inbox for the confirmation link."
        })));
    }

    info!("Login success: {}", data.email);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user.id,
            action: "login",
            resource_type: "session",
            resource_id: None,
            metadata: Some(serde_json::json!({ "method": "password" })),
        },
    )
    .await;
    // Clamp the JWT's `exp` so it never outlives the account's hard
    // expiry. For non-expiring accounts (the default), `max_exp` is
    // None and the standard 24h TTL applies.
    let token = create_jwt_for_account_with_max_exp(
        user.id,
        user.email.clone(),
        user.account_type.clone(),
        user.password_valid_until,
    );

    // Org members get their password-wrapped private key in the login
    // response so the browser can unwrap on a fresh device (where
    // IndexedDB has no cached key). Personal users don't have a row in
    // member_login_wrapped_keys — they get None and stay on the
    // existing mnemonic recovery path.
    let login_wrap = match organization::keys::fetch_login_wrap(pool.get_ref(), user.id).await {
        Ok(Some(wrap)) => Some(MemberLoginWrap {
            iv: wrap.iv,
            ct: wrap.ct,
            salt: wrap.salt,
            iterations: wrap.iterations,
        }),
        Ok(None) => None,
        Err(e) => {
            warn!(target: "auth", error = ?e, user_id = user.id, "login wrap fetch failed");
            None
        }
    };

    Ok(HttpResponse::Ok()
        .cookie(auth_cookie(token.clone()))
        .json(LoginResponse {
            token,
            account_type: user.account_type,
            login_wrap,
        }))
}

#[post("/logout")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn logout(req: HttpRequest, pool: web::Data<PgPool>) -> HttpResponse {
    // Best-effort: record the action only when the request still carries a
    // resolvable identity. Logout always succeeds regardless.
    if let Some(user_id) = get_user_id_from_request(&req) {
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "logout",
                resource_type: "session",
                resource_id: None,
                metadata: None,
            },
        )
        .await;
    }
    HttpResponse::Ok()
        .cookie(expired_auth_cookie())
        .json(serde_json::json!({ "message": "Logged out" }))
}

fn random_token_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// Always responds 200 with a generic message — never reveals whether the
// email exists, to avoid an enumeration oracle.
#[post("/forgot-password")]
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub async fn forgot_password(
    pool: web::Data<PgPool>,
    data: web::Json<ForgotInput>,
) -> HttpResponse {
    info!(target: "auth", "forgot-password request");

    let generic_ok = HttpResponse::Ok().json(serde_json::json!({
        "message": "If that account exists, a reset link has been sent."
    }));

    let user = sqlx::query("SELECT id, email, password FROM users WHERE email = $1")
        .bind(&data.email)
        .fetch_optional(pool.get_ref())
        .await;

    let row = match user {
        Ok(Some(r)) => r,
        Ok(None) => return generic_ok,
        Err(e) => {
            error!(target: "auth", error = %e, "forgot lookup failed");
            return generic_ok;
        }
    };

    // Google-signup users (NULL password) can't reset what they don't have.
    let stored_password: Option<String> = row.try_get("password").ok();
    if stored_password.is_none() {
        info!(target: "auth", "forgot ignored: google-only account");
        return generic_ok;
    }

    let user_id: i32 = row.get("id");
    let token = random_token_hex();
    let expires_at = chrono::Utc::now() + chrono::Duration::minutes(RESET_TTL_MINUTES);

    let insert = sqlx::query(
        "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(&token)
    .bind(expires_at)
    .execute(pool.get_ref())
    .await;

    if let Err(e) = insert {
        error!(target: "auth", error = %e, "reset token insert failed");
        return generic_ok;
    }

    let frontend = crate::config::frontend_url();
    let link = format!("{}/reset-password?token={}", frontend, token);
    let body = format!(
        "Hi,\n\nWe received a request to reset your Wayve password.\n\
         Use the link below within {RESET_TTL_MINUTES} minutes:\n\n{link}\n\n\
         If you didn't request this, you can safely ignore this email.\n"
    );

    if let Err(e) = send_mail(&data.email, "Reset your Wayve password", &body).await {
        error!(target: "auth", error = %e, "reset email send failed");
    }

    generic_ok
}

#[post("/reset-password")]
#[instrument(target = "auth", skip(pool, data))]
pub async fn reset_password(pool: web::Data<PgPool>, data: web::Json<ResetInput>) -> AppResult {
    info!(target: "auth", "reset-password attempt");

    if data.new_password.len() < 6 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Password must be at least 6 characters" })));
    }

    // A lookup failure is treated like an unknown token (400) rather than a
    // 500 — the caller learns nothing either way.
    let row = sqlx::query(
        "SELECT user_id, expires_at, used_at \
         FROM password_reset_tokens WHERE token = $1",
    )
    .bind(&data.token)
    .fetch_optional(pool.get_ref())
    .await;

    let row = match row {
        Ok(Some(r)) => r,
        _ => {
            warn!(target: "auth", "reset rejected: unknown token");
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Invalid or expired link" })));
        }
    };

    let used_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("used_at").ok().flatten();
    let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");
    let user_id: i32 = row.get("user_id");

    if used_at.is_some() || expires_at < chrono::Utc::now() {
        warn!(target: "auth", user_id, "reset rejected: token expired or used");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Invalid or expired link" })));
    }

    let hashed = hash_password(&data.new_password).await?;

    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(&hashed)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1")
        .bind(&data.token)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    info!(target: "auth", user_id, "password reset successful");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Password updated" })))
}

// ---- Recover with mnemonic ------------------------------------------------
//
// A user who forgot their password but kept their 6-word recovery phrase can
// reset their password directly here, no email round-trip. The server proves
// the phrase is correct by trying to AES-GCM-decrypt the user's wrapped
// envelope with the PBKDF2-derived key. If the auth tag passes, the
// mnemonic must be right — no other branch can produce a valid tag.
//
// Wire shape (frontend computes entropy from words client-side so the
// server doesn't need to embed the 2048-word BIP-39 list):
//   { "email": "...", "mnemonic_entropy": "<b64 of 9 bytes>",
//     "new_password": "..." }
//
// On success the response includes the wrapped envelope so the same page
// can immediately unlock the user's E2E keys client-side — saves entering
// the phrase twice.
//
// Note: this endpoint runs a 600,000-iteration PBKDF2 per request, which
// is expensive on purpose. If you ever expose this without rate-limiting
// you give attackers a free DoS surface — gate it at nginx or add a
// per-email throttle table before opening it to the public internet.

#[derive(Deserialize)]
pub struct RecoverWithMnemonicInput {
    pub email: String,
    /// Base64 of the 9-byte BIP-39 entropy derived from the user's 6-word
    /// phrase. Naming reflects what's actually on the wire — the words
    /// never cross the network in this flow.
    pub mnemonic_entropy: String,
    pub new_password: String,
}

const PBKDF2_ITERATIONS: u32 = 600_000;
const PBKDF2_SALT: &[u8] = b"wayve-recovery-v1";

#[post("/auth/recover-with-mnemonic")]
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub async fn recover_with_mnemonic(
    pool: web::Data<PgPool>,
    data: web::Json<RecoverWithMnemonicInput>,
) -> AppResult {
    use aes_gcm::{
        Aes256Gcm, Key, KeyInit, Nonce,
        aead::{Aead, Payload},
    };
    use base64::{Engine, engine::general_purpose::STANDARD as B64};

    info!(target: "auth", "recover-with-mnemonic attempt");

    if data.new_password.len() < 6 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Password must be at least 6 characters" })));
    }

    // Look up the user and their wrapped envelope in one query. Either
    // missing → return the same generic 400 so probing for emails or
    // for accounts-without-recovery yields the same answer.
    let row = sqlx::query(
        "SELECT u.id, u.recovery_mode, w.v, w.iv, w.ct, w.pub_key \
         FROM users u \
         LEFT JOIN user_wrapped_keys w ON w.user_id = u.id \
         WHERE u.email = $1",
    )
    .bind(data.email.trim().to_lowercase())
    .fetch_optional(pool.get_ref())
    .await?;

    let row = match row {
        Some(r) => r,
        None => {
            warn!(target: "auth", "recover-with-mnemonic: user not found");
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Invalid email or recovery phrase" })));
        }
    };

    let user_id: i32 = row.get("id");
    let recovery_mode: String = row
        .try_get("recovery_mode")
        .unwrap_or_else(|_| "full".to_string());
    let envelope_version: Option<i32> = row.try_get("v").ok().flatten();
    let envelope_iv: Option<String> = row.try_get("iv").ok().flatten();
    let envelope_ct: Option<String> = row.try_get("ct").ok().flatten();
    let envelope_pub: Option<String> = row.try_get("pub_key").ok().flatten();

    let (Some(v), Some(iv_b64), Some(ct_b64), Some(pub_b64)) =
        (envelope_version, envelope_iv, envelope_ct, envelope_pub)
    else {
        warn!(target: "auth", user_id, "recover-with-mnemonic: no wrapped envelope on file");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Invalid email or recovery phrase" })));
    };

    if v != 1 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Unsupported envelope version" })));
    }

    // Derive the same PBKDF2 wrapping key the frontend used. Same salt,
    // same iteration count, same hash — see frontend/src/crypto/recovery.ts.
    let entropy = match B64.decode(data.mnemonic_entropy.trim()) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Invalid recovery phrase" })));
        }
    };
    let mut key_bytes = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&entropy, PBKDF2_SALT, PBKDF2_ITERATIONS, &mut key_bytes);

    // Try AES-GCM decrypt. Auth-tag mismatch == wrong mnemonic; no other
    // failure mode produces a successful decrypt with a wrong key.
    let iv = match B64.decode(&iv_b64) {
        Ok(v) if v.len() == 12 => v,
        _ => {
            error!(target: "auth", user_id, "recover-with-mnemonic: stored IV is malformed");
            return Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Recovery payload is corrupted" })));
        }
    };
    let ct = match B64.decode(&ct_b64) {
        Ok(v) => v,
        Err(_) => {
            error!(target: "auth", user_id, "recover-with-mnemonic: stored ciphertext is malformed");
            return Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Recovery payload is corrupted" })));
        }
    };

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&iv);
    let decrypt_result = cipher.decrypt(nonce, Payload { msg: &ct, aad: &[] });
    if decrypt_result.is_err() {
        warn!(
            target: "auth",
            user_id,
            "recover-with-mnemonic: wrong phrase (AES-GCM auth tag mismatch)"
        );
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Invalid email or recovery phrase" })));
    }

    // Mnemonic verified. Set the new password. The wrapped envelope is
    // intentionally untouched — the phrase keeps wrapping the same private
    // key, so the user's existing E2E data stays unlockable.
    let hashed = hash_password(&data.new_password).await?;
    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(&hashed)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    info!(target: "auth", user_id, recovery_mode = %recovery_mode, "recover-with-mnemonic: password reset via recovery phrase");

    // Plan A: every user is 'full', so always return the envelope so
    // the SPA can unlock E2E keys client-side without making the user
    // type the mnemonic a second time. The 'password_only' branch is
    // gone; legacy callers will still see a sensible payload because
    // any pre-migration row was pinned to 'full' by the schema migration.
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user_id": user_id,
        "wrapped_envelope": {
            "v": v,
            "iv": iv_b64,
            "pub": pub_b64,
            "ct": ct_b64,
        },
        "recovery_mode": recovery_mode,
    })))
}

/// Register this domain's routes. Called from `routes::routes` (the aggregator).
#[derive(serde::Deserialize)]
pub struct RegisterBusinessInput {
    pub organization_name: String,
    pub username: String,
    pub email: String,
    pub password: String,
    pub confirm_password: String,
}

/// Direct business signup: create the owner account AND the organization in one
/// step — the owner is minted straight as `organization_admin`, instead of
/// creating a personal account first and upgrading it. Public; no payment here
/// (billing is added later from the billing page). Everything runs in one
/// transaction, so an org-name clash rolls back the just-created user too.
#[post("/register-business")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn register_business(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<RegisterBusinessInput>,
) -> AppResult {
    if data.password != data.confirm_password {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Passwords do not match" })));
    }
    let name = data.organization_name.trim();
    if name.is_empty() || name.len() > 120 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Enter a business name (max 120 chars)" })));
    }
    let username = data.username.trim();
    if username.is_empty() || username.len() > 80 {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Enter a username" }))
        );
    }
    let email = data.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Enter a valid email address" })));
    }

    let hashed = hash_password(&data.password).await?;

    let mut tx = pool.begin().await?;

    let user_row = sqlx::query(
        "INSERT INTO users (username, email, password, auth_provider, account_type, recovery_mode) \
         VALUES ($1, $2, $3, 'local', 'personal', 'full') RETURNING id",
    )
    .bind(username)
    .bind(&email)
    .bind(&hashed)
    .fetch_one(&mut *tx)
    .await;

    let user_id: i32 = match user_row {
        Ok(row) => row.get("id"),
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::BadRequest().json(
                    serde_json::json!({ "message": "An account with that email already exists" }),
                ));
            }
            return Err(AppError::Db(e));
        }
    };

    // Promote the just-created user into the org owner: creates the org + owner
    // membership + starter entitlements and flips account_type to
    // organization_admin. None => org name already taken (tx rolls back).
    let created =
        crate::routes::user::create_org_for_user(&mut tx, user_id, name, None, Some(&email))
            .await?;
    if created.is_none() {
        return Ok(HttpResponse::Conflict().json(
            serde_json::json!({ "message": format!("A business named '{name}' already exists") }),
        ));
    }

    tx.commit().await?;

    let token = create_jwt(user_id, email.clone());
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "login",
            resource_type: "session",
            resource_id: None,
            metadata: Some(serde_json::json!({
                "method": "password",
                "new_user": true,
                "business": true,
            })),
        },
    )
    .await;

    info!(target: "auth", user_id, email = %email, "business registered (direct)");
    Ok(HttpResponse::Ok()
        .cookie(auth_cookie(token.clone()))
        .json(serde_json::json!({ "token": token, "account_type": "organization_admin" })))
}

// Verify a 6-digit code for `email`. Scoped to the user's newest active code;
// wrong codes increment `attempts` and are burned after MAX_VERIFY_ATTEMPTS.
// Bad email / wrong / expired / used all collapse to a generic 400.
#[post("/verify-email")]
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub async fn verify_email(pool: web::Data<PgPool>, data: web::Json<VerifyEmailInput>) -> AppResult {
    info!(target: "auth", "verify-email attempt");

    let bad = || {
        HttpResponse::BadRequest().json(serde_json::json!({ "message": "Invalid or expired code" }))
    };

    // Only local, still-unverified accounts have a code to check.
    let user_row = sqlx::query(
        "SELECT id FROM users \
         WHERE email = $1 AND auth_provider = 'local' AND email_verified = false",
    )
    .bind(&data.email)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(user_row) = user_row else {
        return Ok(bad());
    };
    let user_id: i32 = user_row.get("id");

    // Newest code for this user.
    let row = sqlx::query(
        "SELECT id, token, attempts, expires_at, used_at \
         FROM email_verification_tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Ok(bad());
    };
    let token_id: i32 = row.get("id");
    let stored_code: String = row.try_get("token").unwrap_or_default();
    let attempts: i32 = row.try_get("attempts").unwrap_or(0);
    let used_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("used_at").ok().flatten();
    let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");

    if used_at.is_some() || expires_at < chrono::Utc::now() {
        return Ok(bad());
    }

    if attempts >= MAX_VERIFY_ATTEMPTS {
        // Burn the code so a fresh one must be requested.
        let _ = sqlx::query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1")
            .bind(token_id)
            .execute(pool.get_ref())
            .await;
        warn!(target: "auth", user_id, "verify-email rejected: too many attempts");
        return Ok(HttpResponse::TooManyRequests()
            .json(serde_json::json!({ "message": "Too many attempts. Request a new code." })));
    }

    if stored_code != data.code.trim() {
        sqlx::query("UPDATE email_verification_tokens SET attempts = attempts + 1 WHERE id = $1")
            .bind(token_id)
            .execute(pool.get_ref())
            .await?;
        warn!(target: "auth", user_id, "verify-email rejected: wrong code");
        return Ok(bad());
    }

    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET email_verified = true WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1")
        .bind(token_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    info!(target: "auth", user_id, "email verified");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Email verified" })))
}

// Re-send a verification code. Always responds 200 with a generic message so
// it can't be used to probe which emails exist / are unverified.
#[post("/resend-verification")]
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub async fn resend_verification(
    pool: web::Data<PgPool>,
    data: web::Json<ResendVerificationInput>,
) -> HttpResponse {
    info!(target: "auth", "resend-verification request");

    let generic_ok = HttpResponse::Ok().json(serde_json::json!({
        "message": "If that account needs verification, a new link has been sent."
    }));

    let row = sqlx::query(
        "SELECT id FROM users \
         WHERE email = $1 AND auth_provider = 'local' AND email_verified = false",
    )
    .bind(&data.email)
    .fetch_optional(pool.get_ref())
    .await;

    let user_id: i32 = match row {
        Ok(Some(r)) => r.get("id"),
        _ => return generic_ok,
    };

    if let Err(e) = issue_verification_code_and_email(pool.get_ref(), user_id, &data.email).await {
        error!(target: "auth", error = ?e, "resend verification email failed");
    }
    generic_ok
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(register)
        .service(register_business)
        .service(login)
        .service(logout)
        .service(forgot_password)
        .service(reset_password)
        .service(verify_email)
        .service(resend_verification)
        .service(recover_with_mnemonic);
}
