//! API key authentication.
//!
//! An API key is a credential that authenticates a request as a designated
//! user — no interactive login — constrained by a scope set, a per-key rate
//! limit, and an expiry. Keys are `internal` (may hold the `*` full-access
//! scope) or `external` (explicit scopes only). The raw key is shown once at
//! creation; only its SHA-256 hash is stored, so a leaked database exposes no
//! usable keys.

use crate::config;
use crate::encryption::decrypt;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use rand::RngCore;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::time::Duration;
use tracing::warn;

static SIEM_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| Client::new())
});

/// Generate a cryptographically-random API key: `wv_sk_` + 48 hex chars
/// (192 bits of entropy from the thread CSPRNG).
pub fn generate_api_key() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("wv_sk_{hex}")
}

/// A public client identifier for a registered developer app: `wv_app_` + 32
/// hex chars. Non-secret — safe to display, log, and embed in OAuth redirect
/// flows. Unique per app (enforced by the `developer_apps.client_id` constraint).
pub fn generate_client_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("wv_app_{hex}")
}

/// A developer-app client secret: `wv_cs_` + 48 hex chars (192 bits). Shown once
/// at creation/rotation; only its SHA-256 hash (via [`hash_api_key`]) is stored,
/// so a leaked database exposes no usable secrets.
pub fn generate_client_secret() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("wv_cs_{hex}")
}

/// SHA-256 hex of an API key. API keys are high-entropy tokens, so a fast
/// deterministic hash is correct here — it lets validation be a single indexed
/// lookup on `key_hash` rather than a bcrypt scan over every row.
pub fn hash_api_key(raw: &str) -> String {
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The enumerable API scope catalog (`*` is valid too, but internal-only and
/// not listed here). Used to validate scopes supplied at key creation.
pub const API_SCOPES: &[&str] = &[
    "email:read",
    "email:send",
    "chat:read",
    "chat:write",
    "call:access",
    "scheduler:read",
    "scheduler:write",
    "drive:read",
    "drive:write",
    "notes:read",
    "notes:write",
    "reminders:read",
    "reminders:write",
    "tasks:read",
    "tasks:write",
    "ai:use",
    "profile:read",
    "admin",
];

/// Whether `scope` is a scope a key may be granted (`*` is internal-only).
pub fn is_valid_scope(scope: &str) -> bool {
    scope == "*" || API_SCOPES.contains(&scope)
}

/// Whether a key holding `granted` scopes satisfies `required`. Accepts an
/// exact match, the per-resource wildcard (`notes:*`), or the full `*`.
pub fn scope_satisfied(granted: &[String], required: &str) -> bool {
    let resource_wildcard = required.split_once(':').map(|(res, _)| format!("{res}:*"));
    granted.iter().any(|grant| {
        grant == "*" || grant == required || resource_wildcard.as_deref() == Some(grant.as_str())
    })
}

/// The scope an API-key request needs to reach `(method, path)`.
///
/// `None` means the route is not reachable with an API key at all (auth
/// endpoints, OAuth callbacks, anything unmapped) — the middleware denies it.
pub fn required_scope(method: &str, path: &str) -> Option<&'static str> {
    // WebSocket upgrades are not under /api.
    match path {
        "/ws/chat" => return Some("chat:write"),
        "/ws/call" => return Some("call:access"),
        _ => {}
    }

    let rest = path.strip_prefix("/api/")?;
    let resource = rest.split('/').next().unwrap_or("");
    let is_read = matches!(method, "GET" | "HEAD");

    let scope = match resource {
        "emails" | "email" | "email-files" | "accounts" => {
            if is_read {
                "email:read"
            } else {
                "email:send"
            }
        }
        "messages" | "chat" | "channels" => {
            if is_read {
                "chat:read"
            } else {
                "chat:write"
            }
        }
        "call" => "call:access",
        "meetings" | "scheduler" => {
            if is_read {
                "scheduler:read"
            } else {
                "scheduler:write"
            }
        }
        "files" | "drive" => {
            if is_read {
                "drive:read"
            } else {
                "drive:write"
            }
        }
        "notes" => {
            if is_read {
                "notes:read"
            } else {
                "notes:write"
            }
        }
        "reminders" => {
            if is_read {
                "reminders:read"
            } else {
                "reminders:write"
            }
        }
        "tasks" => {
            if is_read {
                "tasks:read"
            } else {
                "tasks:write"
            }
        }
        "ai" | "aichat" => "ai:use",
        "me" | "users" => "profile:read",
        "profile" => {
            if is_read {
                "profile:read"
            } else {
                "admin"
            }
        }
        // Management surfaces — keys, RBAC, audit, billing, org/platform admin.
        // `workspace-tickets` and `user-stories` are here so the AI-fix CI
        // callbacks (resolution + ai-fix-diff) authenticate with an internal
        // management key; the handlers then enforce tickets:manage on the key's
        // user. Both boards run the same pipeline, so both need the same reach.
        "admin" | "keys" | "developer" | "audit" | "organizations" | "platform" | "billing"
        | "v1" | "workspace-tickets" | "user-stories" | "pr-notify" => "admin",
        _ => return None,
    };
    Some(scope)
}

/// Resolved API-key identity, injected into request extensions by the
/// middleware so `get_user_id_from_request` (and thus every handler) sees it.
#[derive(Debug, Clone)]
pub struct ApiKeyPrincipal {
    pub user_id: i32,
    pub key_id: i32,
    pub key_type: String,
    pub scopes: Vec<String>,
}

/// Why an API key failed to resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    Invalid,
    Revoked,
    Expired,
}

/// A valid, live API key.
#[derive(Debug, Clone)]
pub struct ResolvedKey {
    pub id: i32,
    pub user_id: i32,
    pub key_type: String,
    pub scopes: Vec<String>,
    pub rate_limit_per_min: i32,
}

/// Look up a raw `X-API-KEY` value, rejecting unknown / revoked / expired keys.
/// On success, stamps `last_used_at` (best-effort).
pub async fn resolve_api_key(pool: &PgPool, raw_key: &str) -> Result<ResolvedKey, AuthFailure> {
    let key_hash = hash_api_key(raw_key);

    let row = sqlx::query(
        r#"
        SELECT id, user_id, key_type, scopes, rate_limit_per_min, revoked_at, expires_at
        FROM api_keys
        WHERE key_hash = $1
        "#,
    )
    .bind(&key_hash)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .ok_or(AuthFailure::Invalid)?;

    let revoked_at: Option<DateTime<Utc>> = row.try_get("revoked_at").ok().flatten();
    if revoked_at.is_some() {
        return Err(AuthFailure::Revoked);
    }

    let expires_at: Option<DateTime<Utc>> = row.try_get("expires_at").ok().flatten();
    if let Some(expiry) = expires_at
        && expiry < Utc::now()
    {
        return Err(AuthFailure::Expired);
    }

    // A key with no acting principal cannot authenticate anyone.
    let user_id: i32 = row
        .try_get("user_id")
        .ok()
        .flatten()
        .ok_or(AuthFailure::Invalid)?;
    let id: i32 = row.get("id");

    let _ = sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await;

    Ok(ResolvedKey {
        id,
        user_id,
        key_type: row
            .try_get("key_type")
            .unwrap_or_else(|_| "external".to_string()),
        scopes: row.try_get("scopes").unwrap_or_default(),
        rate_limit_per_min: row.try_get("rate_limit_per_min").unwrap_or(120),
    })
}

/// Outcome recorded for one API-key-authenticated request.
#[derive(Debug, Clone, Copy)]
pub enum AuditOutcome {
    Allowed,
    DeniedScope,
    DeniedExpired,
    DeniedRevoked,
    RateLimited,
    Invalid,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Allowed => "allowed",
            AuditOutcome::DeniedScope => "denied_scope",
            AuditOutcome::DeniedExpired => "denied_expired",
            AuditOutcome::DeniedRevoked => "denied_revoked",
            AuditOutcome::RateLimited => "rate_limited",
            AuditOutcome::Invalid => "invalid",
        }
    }
}

/// One row to append to the API-key audit log. Owns its strings so it can be
/// moved into a fire-and-forget audit task.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub api_key_id: Option<i32>,
    pub user_id: Option<i32>,
    pub method: String,
    pub path: String,
    pub status_code: i32,
    pub outcome: AuditOutcome,
    pub ip: Option<String>,
}

#[derive(Serialize)]
struct SiemAuditEvent<'a> {
    event_type: &'static str,
    audit_id: i64,
    api_key_id: Option<i32>,
    user_id: Option<i32>,
    method: &'a str,
    path: &'a str,
    status_code: i32,
    outcome: &'static str,
    ip: Option<&'a str>,
    created_at: DateTime<Utc>,
}

struct SiemTarget {
    webhook_url: String,
    webhook_token: Option<String>,
}

/// Append one row to the API-key audit log (best-effort — never blocks or
/// fails the request).
pub async fn write_audit(pool: &PgPool, entry: &AuditEntry) {
    let inserted = sqlx::query(
        r#"
        INSERT INTO api_key_audit_log
            (api_key_id, user_id, method, path, status_code, outcome, ip)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, created_at
        "#,
    )
    .bind(entry.api_key_id)
    .bind(entry.user_id)
    .bind(&entry.method)
    .bind(&entry.path)
    .bind(entry.status_code)
    .bind(entry.outcome.as_str())
    .bind(entry.ip.as_deref())
    .fetch_one(pool)
    .await;

    let Ok(row) = inserted else {
        return;
    };

    forward_audit_to_siem(pool, entry, row.get("id"), row.get("created_at")).await;
}

async fn forward_audit_to_siem(
    pool: &PgPool,
    entry: &AuditEntry,
    audit_id: i64,
    created_at: DateTime<Utc>,
) {
    let Some(target) = load_siem_target(pool, entry.user_id).await else {
        return;
    };

    let event = SiemAuditEvent {
        event_type: "api_key_audit",
        audit_id,
        api_key_id: entry.api_key_id,
        user_id: entry.user_id,
        method: &entry.method,
        path: &entry.path,
        status_code: entry.status_code,
        outcome: entry.outcome.as_str(),
        ip: entry.ip.as_deref(),
        created_at,
    };

    let mut request = SIEM_CLIENT.post(target.webhook_url).json(&event);
    if let Some(token) = target.webhook_token {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => warn!(
            target: "auth",
            audit_id,
            status = %response.status(),
            "siem audit webhook returned non-success status"
        ),
        Err(error) => warn!(
            target: "auth",
            audit_id,
            error = ?error,
            "siem audit webhook request failed"
        ),
    }
}

async fn load_siem_target(pool: &PgPool, user_id: Option<i32>) -> Option<SiemTarget> {
    if let Some(user_id) = user_id {
        let row = sqlx::query(
            r#"
            SELECT c.webhook_url, c.token_iv, c.token_encrypted
            FROM siem_webhook_configs c
            JOIN users u ON u.id = $1
            WHERE c.enabled = TRUE
              AND (
                (c.scope = 'platform' AND u.account_type = 'platform_admin')
                OR (c.scope = 'organization' AND c.organization_id = u.organization_id)
                OR (c.scope = 'personal' AND c.user_id = u.id)
              )
            ORDER BY CASE c.scope
                WHEN 'personal' THEN 1
                WHEN 'organization' THEN 2
                WHEN 'platform' THEN 3
                ELSE 4
              END
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

        if let Some(row) = row {
            let webhook_url: String = row.get("webhook_url");
            let token = decrypt_optional_token(&row);
            return Some(SiemTarget {
                webhook_url,
                webhook_token: token,
            });
        }
    }

    let env = config::siem();
    env.webhook_url.map(|webhook_url| SiemTarget {
        webhook_url,
        webhook_token: env.webhook_token,
    })
}

fn decrypt_optional_token(row: &sqlx::postgres::PgRow) -> Option<String> {
    let iv: Option<String> = row.try_get("token_iv").ok().flatten();
    let encrypted: Option<String> = row.try_get("token_encrypted").ok().flatten();
    match (iv, encrypted) {
        (Some(iv), Some(encrypted)) if !iv.is_empty() && !encrypted.is_empty() => {
            decrypt(&iv, &encrypted).ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_are_unique_and_prefixed() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert!(a.starts_with("wv_sk_"));
        assert_eq!(a.len(), "wv_sk_".len() + 48);
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_stable_and_distinct() {
        assert_eq!(hash_api_key("wv_sk_abc"), hash_api_key("wv_sk_abc"));
        assert_ne!(hash_api_key("wv_sk_abc"), hash_api_key("wv_sk_xyz"));
    }

    #[test]
    fn scope_matching_handles_exact_resource_and_full_wildcards() {
        let exact = vec!["notes:read".to_string()];
        assert!(scope_satisfied(&exact, "notes:read"));
        assert!(!scope_satisfied(&exact, "notes:write"));

        let resource = vec!["notes:*".to_string()];
        assert!(scope_satisfied(&resource, "notes:read"));
        assert!(scope_satisfied(&resource, "notes:write"));
        assert!(!scope_satisfied(&resource, "email:read"));

        let full = vec!["*".to_string()];
        assert!(scope_satisfied(&full, "notes:read"));
        assert!(scope_satisfied(&full, "admin"));

        assert!(!scope_satisfied(&[], "notes:read"));
    }

    #[test]
    fn required_scope_maps_routes_by_resource_and_method() {
        assert_eq!(required_scope("GET", "/api/notes"), Some("notes:read"));
        assert_eq!(required_scope("POST", "/api/notes"), Some("notes:write"));
        assert_eq!(
            required_scope("DELETE", "/api/notes/42"),
            Some("notes:write")
        );
        assert_eq!(required_scope("GET", "/api/emails"), Some("email:read"));
        assert_eq!(required_scope("GET", "/api/me"), Some("profile:read"));
        assert_eq!(required_scope("PUT", "/api/me/theme"), Some("profile:read"));
        assert_eq!(
            required_scope("POST", "/api/profile/password"),
            Some("admin")
        );
        assert_eq!(required_scope("POST", "/api/keys"), Some("admin"));
        // AI-fix CI callbacks authenticate with an internal management key.
        assert_eq!(
            required_scope("POST", "/api/workspace-tickets/7/ai-fix-diff"),
            Some("admin")
        );
        // Stories run the same AI-fix pipeline, so their CI callback needs the
        // same reach as the ticket one.
        assert_eq!(
            required_scope("POST", "/api/user-stories/7/ai-fix-diff"),
            Some("admin")
        );
        assert_eq!(required_scope("GET", "/ws/chat"), Some("chat:write"));
        // Unmapped / auth routes are unreachable with an API key.
        assert_eq!(required_scope("POST", "/api/login"), None);
        assert_eq!(required_scope("GET", "/oauth/callback"), None);
    }

    #[test]
    fn scope_validity() {
        assert!(is_valid_scope("notes:read"));
        assert!(is_valid_scope("*"));
        assert!(!is_valid_scope("notes:destroy"));
        assert!(!is_valid_scope(""));
    }
}
