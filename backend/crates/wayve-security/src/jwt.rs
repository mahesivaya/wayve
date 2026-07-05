use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use tracing::warn;

fn default_account_type() -> String {
    "personal".to_string()
}

/// Interactive session privilege mode carried in the JWT. An owner logs in as
/// `Normal` (a downscoped, restricted identity) and explicitly switches to
/// `Admin` to reach the admin console. The mode can only ever *reduce*
/// privilege relative to the DB role (see `rbac::downscope_for_mode`), so it is
/// safe to carry in the token — it is never trusted to *grant* anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    #[default]
    Normal,
    Admin,
}

impl SessionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionMode::Normal => "normal",
            SessionMode::Admin => "admin",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> SessionMode {
        match value {
            "admin" => SessionMode::Admin,
            _ => SessionMode::Normal,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i32,
    pub email: String,
    #[serde(default = "default_account_type")]
    pub account_type: String,
    // Absent on tokens minted before this feature ⇒ default `Normal`.
    #[serde(default)]
    pub mode: SessionMode,
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
    // Every existing login/OAuth/SSO mint path funnels here and gets `Normal`,
    // so a fresh login is always the restricted identity. Only the explicit
    // session-mode switch endpoint mints `Admin` (via `create_jwt_with_mode`).
    create_jwt_with_mode(user_id, email, account_type, max_exp, SessionMode::Normal)
}

/// Mint a JWT with an explicit session mode. Used by the admin-mode switch
/// endpoint; all other callers go through the `Normal`-defaulting wrappers.
pub fn create_jwt_with_mode(
    user_id: i32,
    email: String,
    account_type: String,
    max_exp: Option<DateTime<Utc>>,
    mode: SessionMode,
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
        mode,
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
    // Must mirror the Secure flag used by `auth_cookie` (HTTPS in prod).
    // Browsers reject a non-Secure cookie attempting to overwrite a
    // Secure one of the same name, so without this the logout response
    // silently fails to clear the cookie and the user is still
    // authenticated on the next page load.
    //
    // We also set `expires` to the Unix epoch alongside `max_age(0)` —
    // iOS Safari/WebKit (and Chrome iOS, which is WebKit-backed) has
    // been observed to ignore Max-Age=0 alone on the second-and-later
    // cookie-clear in a session, but reliably honors `Expires` in the
    // past. Setting both is the recommended belt-and-suspenders form
    // and matches what most production identity stacks ship.
    let secure = crate::config::auth_cookie_secure();
    Cookie::build(AUTH_COOKIE_NAME, "")
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(actix_web::cookie::time::Duration::seconds(0))
        .expires(actix_web::cookie::time::OffsetDateTime::UNIX_EPOCH)
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
    if let Some(principal) = req.extensions().get::<crate::api_key::ApiKeyPrincipal>() {
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

/// Resolve the session mode for a request. API-key and embed principals carry
/// no mode and are treated as `Normal` (least privilege — a programmatic key
/// cannot silently act as admin). Interactive JWT sessions carry the claim;
/// tokens minted before this feature decode as `Normal` via the serde default.
pub fn mode_from_request(req: &HttpRequest) -> SessionMode {
    if req
        .extensions()
        .get::<crate::api_key::ApiKeyPrincipal>()
        .is_some()
        || req
            .extensions()
            .get::<crate::embed::middleware::EmbedPrincipal>()
            .is_some()
    {
        return SessionMode::Normal;
    }

    token_from_request(req)
        .and_then(|token| decode_jwt(&token))
        .map(|claims| claims.mode)
        .unwrap_or(SessionMode::Normal)
}
