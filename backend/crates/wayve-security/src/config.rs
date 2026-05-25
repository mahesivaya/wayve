//! Env-var helpers for the security crate.
//!
//! These mirror the corresponding helpers in `wayve-server`'s `config.rs` —
//! duplicated rather than imported so wayve-security doesn't reach back
//! into the app crate. Future workspace evolution can collapse both into
//! a shared `wayve-config` crate; for now the surface is small enough
//! that duplication is the right trade.

use std::env;

fn var_opt(key: &str) -> Option<String> {
    env::var(key).ok().and_then(|raw| {
        let trimmed = raw
            .split_once('#')
            .map_or(raw.as_str(), |(value, _comment)| value)
            .trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// HS256 signing secret. Panics if missing, blank, or the placeholder
/// `secret` — the app must not run with an insecure JWT secret.
pub fn jwt_secret() -> String {
    let secret = env::var("JWT_SECRET").unwrap_or_else(|_| {
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

/// AES-256-GCM input key material (Hex64). `None` ⇒ at-rest encryption unusable.
pub fn aes_key() -> Option<String> {
    var_opt("AES_KEY")
}

/// Optional HKDF salt; keep stable forever once set.
pub fn aes_hkdf_salt() -> Option<String> {
    var_opt("AES_HKDF_SALT")
}

/// Whether the auth cookie carries the `Secure` attribute (true in production).
pub fn auth_cookie_secure() -> bool {
    env::var("AUTH_COOKIE_SECURE")
        .map(|value| value != "false" && value != "0")
        .unwrap_or(false)
}

pub struct SiemConfig {
    pub webhook_url: Option<String>,
    pub webhook_token: Option<String>,
}

pub fn siem() -> SiemConfig {
    SiemConfig {
        webhook_url: var_opt("SIEM_WEBHOOK_URL"),
        webhook_token: var_opt("SIEM_WEBHOOK_TOKEN"),
    }
}
