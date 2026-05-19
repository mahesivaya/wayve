use chrono::{Duration as ChronoDuration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use tracing::warn;

fn default_account_type() -> String {
    "personal".to_string()
}

pub fn jwt_secret() -> String {
    let secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        panic!("JWT_SECRET missing; refusing to start with an insecure default")
    });
    let secret = secret.trim().to_string();

    if secret.is_empty() {
        panic!("JWT_SECRET is empty; refusing to start with an insecure secret");
    }

    if secret == "secret" {
        panic!("JWT_SECRET must not be the placeholder value 'secret'");
    }

    secret
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
    let secret = jwt_secret();

    let expiration = Utc::now()
        .checked_add_signed(ChronoDuration::hours(24))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: user_id,
        email,
        account_type,
        exp: expiration,
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
    let secret = jwt_secret();

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
    let secure = std::env::var("AUTH_COOKIE_SECURE")
        .map(|value| value != "false" && value != "0")
        .unwrap_or(false);

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
        .get::<crate::security::api_key::ApiKeyPrincipal>()
    {
        return Some(principal.user_id);
    }

    let token = token_from_request(req)?;
    let claims = decode_jwt(&token)?;
    Some(claims.sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn jwt_secret_panics_when_missing() {
        unsafe {
            std::env::remove_var("JWT_SECRET");
        }

        let result = std::panic::catch_unwind(jwt_secret);

        assert!(result.is_err());
    }

    #[test]
    #[serial_test::serial]
    fn jwt_secret_rejects_placeholder_secret() {
        unsafe {
            std::env::set_var("JWT_SECRET", "secret");
        }

        let result = std::panic::catch_unwind(jwt_secret);

        unsafe {
            std::env::set_var("JWT_SECRET", "test-jwt-secret");
        }

        assert!(result.is_err());
    }

    #[test]
    #[serial_test::serial]
    fn jwt_secret_accepts_configured_secret() {
        unsafe {
            std::env::set_var("JWT_SECRET", "test-jwt-secret");
        }

        assert_eq!(jwt_secret(), "test-jwt-secret");
    }
}
