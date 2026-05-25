// Embed-token claims + sign/verify helpers.

use chrono::{Duration as ChronoDuration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

pub const EMBED_ISSUER: &str = "wayve-embed";
pub const EMBED_TTL_SECONDS: i64 = 300;

/// The scopes a token may declare. Strictly read-side; the middleware
/// enforces GET-only at the HTTP method layer in addition.
pub const ALLOWED_SCOPES: &[&str] = &[
    "profile:read",
    "email:read",
    "chat:read",
    "scheduler:read",
    "drive:read",
    "notes:read",
    "tasks:read",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbedClaims {
    pub sub: i32,
    pub iss: String,
    /// The exact `Origin` header the embedding page must send. The
    /// middleware rejects the request if it doesn't match.
    pub aud: String,
    /// Subset of `ALLOWED_SCOPES`.
    pub scopes: Vec<String>,
    pub exp: usize,
    /// Random per-token nonce; useful for log correlation if you later
    /// add a token-tracking table.
    pub jti: String,
}

#[derive(Debug)]
pub enum MintError {
    EmptyScopes,
    UnknownScope(String),
    EmptyOrigin,
}

impl std::fmt::Display for MintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MintError::EmptyScopes => write!(f, "scopes must list at least one entry"),
            MintError::UnknownScope(s) => write!(f, "scope '{s}' is not a permitted embed scope"),
            MintError::EmptyOrigin => write!(f, "origin must be a non-empty URL"),
        }
    }
}

pub fn mint(user_id: i32, origin: &str, scopes: &[String]) -> Result<String, MintError> {
    let origin = origin.trim();
    if origin.is_empty() {
        return Err(MintError::EmptyOrigin);
    }
    if scopes.is_empty() {
        return Err(MintError::EmptyScopes);
    }
    for s in scopes {
        if !ALLOWED_SCOPES.contains(&s.as_str()) {
            return Err(MintError::UnknownScope(s.clone()));
        }
    }
    let secret = crate::config::jwt_secret();
    let exp = (Utc::now() + ChronoDuration::seconds(EMBED_TTL_SECONDS)).timestamp() as usize;
    let claims = EmbedClaims {
        sub: user_id,
        iss: EMBED_ISSUER.to_string(),
        aud: origin.to_string(),
        scopes: scopes.to_vec(),
        exp,
        jti: format!("emb_{}", uuid::Uuid::new_v4().simple()),
    };
    Ok(encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap_or_default())
}

#[derive(Debug)]
pub enum VerifyError {
    Decode,
    WrongIssuer,
    Expired,
}

pub fn verify(token: &str) -> Result<EmbedClaims, VerifyError> {
    let secret = crate::config::jwt_secret();
    let mut validation = Validation::new(Algorithm::HS256);
    // We do origin matching ourselves against the request's Origin
    // header, not via the `aud` claim — skip jsonwebtoken's audience
    // check which would otherwise require us to know the audience up
    // front.
    validation.validate_aud = false;
    let token_data = decode::<EmbedClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| {
        if matches!(
            e.kind(),
            jsonwebtoken::errors::ErrorKind::ExpiredSignature
        ) {
            VerifyError::Expired
        } else {
            VerifyError::Decode
        }
    })?;
    if token_data.claims.iss != EMBED_ISSUER {
        return Err(VerifyError::WrongIssuer);
    }
    Ok(token_data.claims)
}
