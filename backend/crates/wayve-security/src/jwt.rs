use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use tracing::warn;

fn default_account_type() -> String {
    "personal".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub email: String,
    #[serde(default = "default_account_type")]
    pub account_type: String,
    pub exp: usize,
}

// 🔥 CREATE JWT
pub fn create_jwt(user_id: i32, email: String) -> String {
    create_jwt_for_account(user_id, email, "personal".to_string())
}

pub fn create_jwt_for_account(user_id: i32, email: String, account_type: String) -> String {
    create_jwt_for_account_with_max_exp(user_id, email, account_type, None)
}

/// Variant of `create_jwt_for_account` that clamps the JWT's `exp`
/// claim against an optional ceiling. The default JWT TTL is 24h; if
/// `max_exp` is set and is sooner than 24h from now, that earlier
/// time is used. Used today for short-lived guest accounts whose
/// `password_valid_until` is closer than the default JWT lifetime,
/// so a guest who logs in late in their 24h window can't extend it
/// by another 24h via the JWT.
pub fn create_jwt_for_account_with_max_exp(
    user_id: i32,
    email: String,
    account_type: String,
    max_exp: Option<DateTime<Utc>>,
) -> String {
    let secret = crate::config::jwt_secret();

    let default_expiration = Utc::now()
        .checked_add_signed(ChronoDuration::hours(24))
        .expect("valid timestamp");

    // Clamp against `max_exp` if provided. If the ceiling has already
    // passed we still emit a token here — the caller is expected to
    // have rejected the login first; we never silently issue an
    // already-expired token because the callers above the JWT layer
    // own the "is this still valid" decision.
    let expiration = match max_exp {
        Some(cap) if cap < default_expiration => cap,
        _ => default_expiration,
    };

    let claims = Claims {
        sub: user_id,
        email,
        account_type,
        exp: expiration.timestamp() as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap_or_else(|e| panic!("JWT encode failed: {e}"))
}

// 🔥 DECODE JWT
pub fn decode_jwt(token: &str) -> Option<Claims> {
    let secret = crate::config::jwt_secret();

    match decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    ) {
        Ok(data) => Some(data.claims),
        Err(e) => {
            warn!(target: "auth", error = %e, "jwt decode failed");
            None
        }
    }
}

// 🔥 Extract user from request
use actix_web::cookie::{Cookie, SameSite};
use actix_web::{HttpMessage, HttpRequest};

pub const AUTH_COOKIE_NAME: &str = "rwayve_auth";

pub fn auth_cookie(token: String) -> Cookie<'static> {
    let secure = crate::config::auth_cookie_secure();

    Cookie::build(AUTH_COOKIE_NAME, token)
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(actix_web::cookie::time::Duration::hours(24))
        .finish()
}

pub fn expired_auth_cookie() -> Cookie<'static> {
    Cookie::build(AUTH_COOKIE_NAME, "")
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(actix_web::cookie::time::Duration::seconds(0))
        .finish()
}

pub fn token_from_request(req: &HttpRequest) -> Option<String> {
    if let Some(token) = req
        .headers()
        .get("Authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
    {
        return Some(token.to_string());
    }

    req.cookie(AUTH_COOKIE_NAME)
        .map(|cookie| cookie.value().to_string())
        .filter(|token| !token.trim().is_empty())
}

pub fn get_user_id_from_request(req: &HttpRequest) -> Option<i32> {
    // An API-key request carries an ApiKeyPrincipal injected by the
    // ApiKeyMiddleware; it authenticates the acting user without a JWT.
    if let Some(principal) = req
        .extensions()
        .get::<crate::api_key::ApiKeyPrincipal>()
    {
        return Some(principal.user_id);
    }

    // Embed-token requests come through the EmbedMiddleware which has
    // already verified the signature, origin, and method. Trust the
    // principal it stamped.
    if let Some(principal) = req
        .extensions()
        .get::<crate::embed::middleware::EmbedPrincipal>()
    {
        return Some(principal.user_id);
    }

    let token = token_from_request(req)?;
    let claims = decode_jwt(&token)?;
    Some(claims.sub)
}
