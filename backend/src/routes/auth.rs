use crate::prelude::*;

use crate::email::sender::send_mail;
use crate::models::auth::{ForgotInput, LoginInput, LoginResponse, RegisterInput, ResetInput};
use crate::models::message::MessageResponse;
use crate::models::user::User;
use crate::security::jwt::{auth_cookie, create_jwt, create_jwt_for_account, expired_auth_cookie};
use crate::security::password::{hash_password, verify_password};
use rand::RngCore;
use tracing::{error, info, instrument, warn};

const RESET_TTL_MINUTES: i64 = 30;
const DUMMY_PASSWORD_HASH: &str = "$2b$12$BeUHqArduWoNmhYKnepJYeYTQdhF/XcdcGFHaxiz0/H3JJUbHyLGe";

#[post("/register")]
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub async fn register(pool: web::Data<PgPool>, data: web::Json<RegisterInput>) -> AppResult {
    info!(target: "auth", "register attempt");

    if data.password != data.confirm_password {
        warn!(target: "auth", "register rejected: password mismatch");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Passwords do not match" })));
    }

    let hashed = hash_password(&data.password).await?;

    let result = sqlx::query("INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id")
        .bind(&data.email)
        .bind(&hashed)
        .fetch_one(pool.get_ref())
        .await;

    match result {
        Ok(row) => {
            let user_id: i32 = row.get("id");
            info!("User registered: {}", data.email);
            let token = create_jwt(user_id, data.email.clone());
            Ok(HttpResponse::Ok()
                .cookie(auth_cookie(token.clone()))
                .json(serde_json::json!({
                    "token": token,
                    "account_type": "personal"
                })))
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
#[instrument(target = "auth", skip(pool, data), fields(email = %data.email))]
pub(crate) async fn login(pool: web::Data<PgPool>, data: web::Json<LoginInput>) -> AppResult {
    info!(target: "auth", "login attempt");

    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, password, account_type FROM users WHERE email = $1",
    )
    .bind(&data.email)
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
            return Ok(HttpResponse::Unauthorized().json(MessageResponse {
                message: "Use 'Sign in with Google' for this account".to_string(),
            }));
        }
    };

    let valid = verify_password(&data.password, stored_password).await?;

    if !valid {
        warn!("Invalid login attempt: {}", data.email);
        return Ok(HttpResponse::Unauthorized().json(MessageResponse {
            message: "Invalid credentials".to_string(),
        }));
    }

    info!("Login success: {}", data.email);
    let token = create_jwt_for_account(user.id, user.email.clone(), user.account_type.clone());
    Ok(HttpResponse::Ok()
        .cookie(auth_cookie(token.clone()))
        .json(LoginResponse {
            token,
            account_type: user.account_type,
        }))
}

#[post("/logout")]
#[instrument(target = "auth")]
pub async fn logout() -> HttpResponse {
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
