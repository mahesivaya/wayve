//! Shared building blocks for audit-log inserts.
//!
//! Each audit table has its own column shape (e.g. `org_key_audit_log` has
//! `actor_role + target_user_id`; `api_key_audit_log` has `key_id + outcome`),
//! so the actual `INSERT` statement stays in the owning module. What IS shared
//! is the request-derived context: caller IP and User-Agent. Those two
//! extractions are duplicated in every module that writes an audit row today
//! (see `organization/keys.rs::{client_ip, user_agent}` for the original).
//!
//! This module hoists those helpers so any future audit writer can:
//! ```ignore
//! use crate::audit;
//!
//! sqlx::query("INSERT INTO some_audit_log (…, ip, user_agent) VALUES (…, $7, $8)")
//!     .bind(audit::client_ip(&req))
//!     .bind(audit::user_agent(&req))
//!     .execute(pool)
//!     .await?;
//! ```
//!
//! Existing modules are not migrated — they can switch to these on next touch.

use actix_web::HttpRequest;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::warn;

/// The caller's IP, honoring `X-Forwarded-For` via Actix's `ConnectionInfo`.
/// Returns `None` when the connection has no peer address (in-process tests).
pub fn client_ip(req: &HttpRequest) -> Option<String> {
    req.connection_info().realip_remote_addr().map(String::from)
}

/// The caller's `User-Agent`, or `None` if absent / not UTF-8.
pub fn user_agent(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
}

// ── General user-action audit log ────────────────────────────────────
// A security-relevant action a user just took (password change, deletion,
// export/download, billing change, …). Recorded to the `audit_logs` table
// for the Security audit page and mirrored to logs/user_actions.log.

const USER_ACTIONS_LOG_DIR: &str = "logs";
const USER_ACTIONS_LOG_PATH: &str = "logs/user_actions.log";

/// One audit event. Grouped into a struct so `record_action` stays at two
/// arguments (the surrounding request + the event) rather than a long list.
pub struct AuditEvent<'a> {
    pub actor_user_id: i32,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Record a user action. Best-effort on both sinks: a logging failure is
/// warned and swallowed so it never blocks the action being audited.
pub async fn record_action(pool: &PgPool, req: &HttpRequest, event: AuditEvent<'_>) {
    let ip = client_ip(req);
    let ua = user_agent(req);
    record(pool, event, ip, ua).await;
}

/// Like [`record_action`] but for events with no originating HTTP request —
/// e.g. the background sync worker recording `email_received`. IP and
/// User-Agent are recorded as NULL.
pub async fn record_action_system(pool: &PgPool, event: AuditEvent<'_>) {
    record(pool, event, None, None).await;
}

// ── Billing / financial audit log ────────────────────────────────────
// Plan changes, entitlement grants and subscription state transitions are a
// financial + abuse signal. They mostly originate from Stripe webhooks (no
// HTTP request) and are owned by *either* a user or an organization — so
// neither [`record_action`] (needs a request) nor [`record_action_system`]
// (derives the org from a single known user) fits. This writer takes both
// owner ids explicitly; either may be NULL.

/// One billing audit event. Grouped into a struct so `record_billing` stays
/// at two arguments (mirrors [`AuditEvent`]).
pub struct BillingAuditEvent<'a> {
    pub actor_user_id: Option<i32>,
    pub organization_id: Option<i32>,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Record a billing/financial audit event into `audit_logs` (and mirror it to
/// `user_actions.log`) so it shows up on the Security / User Logs pages
/// alongside every other audited action. Best-effort on both sinks — a logging
/// failure is warned and swallowed so it never blocks (or makes Stripe retry)
/// the billing state change being audited.
pub async fn record_billing(pool: &PgPool, event: BillingAuditEvent<'_>) {
    let metadata_text = event.metadata.as_ref().map(|v| v.to_string());

    if let Err(err) = sqlx::query(
        r#"
        INSERT INTO audit_logs
            (actor_user_id, organization_id, action, resource_type,
             resource_id, metadata, ip, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, NULL)
        "#,
    )
    .bind(event.actor_user_id)
    .bind(event.organization_id)
    .bind(event.action)
    .bind(event.resource_type)
    .bind(event.resource_id.as_deref())
    .bind(metadata_text.as_deref())
    .execute(pool)
    .await
    {
        warn!(target: "billing", error = ?err, action = event.action, "audit_logs billing insert failed");
    }

    append_user_action_log(serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "actor_user_id": event.actor_user_id,
        "organization_id": event.organization_id,
        "action": event.action,
        "resource_type": event.resource_type,
        "resource_id": event.resource_id,
        "metadata": event.metadata,
        "ip": serde_json::Value::Null,
        "user_agent": serde_json::Value::Null,
    }))
    .await;
}

/// Record a FAILED login attempt — the earliest breach signal (credential
/// stuffing, brute force, password spraying). Unlike [`record_action`], the
/// actor may be unknown (a login for a non-existent email), so the actor id is
/// optional and the attempted email + failure `reason` are kept in metadata.
/// Writes `action = "login_failed"` to `audit_logs` (and mirrors to
/// `user_actions.log`) so it shows up alongside successful logins on the
/// Security audit page. Best-effort — never blocks the 401 it accompanies.
pub async fn record_login_failure(
    pool: &PgPool,
    req: &HttpRequest,
    email: &str,
    reason: &str,
    actor_user_id: Option<i32>,
) {
    let ip = client_ip(req);
    let ua = user_agent(req);

    let organization_id: Option<i32> = match actor_user_id {
        Some(id) => sqlx::query_scalar("SELECT organization_id FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten(),
        None => None,
    };

    let metadata = serde_json::json!({ "reason": reason, "email": email });
    let metadata_text = metadata.to_string();

    if let Err(err) = sqlx::query(
        r#"
        INSERT INTO audit_logs
            (actor_user_id, organization_id, action, resource_type,
             resource_id, metadata, ip, user_agent)
        VALUES ($1, $2, 'login_failed', 'session', NULL, $3::jsonb, $4, $5)
        "#,
    )
    .bind(actor_user_id)
    .bind(organization_id)
    .bind(&metadata_text)
    .bind(ip.as_deref())
    .bind(ua.as_deref())
    .execute(pool)
    .await
    {
        warn!(target: "auth", error = ?err, "audit_logs login_failed insert failed");
    }

    append_user_action_log(serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "actor_user_id": actor_user_id,
        "organization_id": organization_id,
        "action": "login_failed",
        "resource_type": "session",
        "resource_id": serde_json::Value::Null,
        "metadata": metadata,
        "ip": ip,
        "user_agent": ua,
    }))
    .await;
}

/// Shared writer: inserts the `audit_logs` row and mirrors it to
/// `logs/user_actions.log`. Both sinks are best-effort.
async fn record(pool: &PgPool, event: AuditEvent<'_>, ip: Option<String>, ua: Option<String>) {
    // The actor's organization at the time of the action — denormalized so
    // the scoped reads on the Security page don't need a live join.
    let organization_id: Option<i32> =
        sqlx::query_scalar("SELECT organization_id FROM users WHERE id = $1")
            .bind(event.actor_user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    let metadata_text = event.metadata.as_ref().map(|v| v.to_string());

    if let Err(err) = sqlx::query(
        r#"
        INSERT INTO audit_logs
            (actor_user_id, organization_id, action, resource_type,
             resource_id, metadata, ip, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        "#,
    )
    .bind(event.actor_user_id)
    .bind(organization_id)
    .bind(event.action)
    .bind(event.resource_type)
    .bind(event.resource_id.as_deref())
    .bind(metadata_text.as_deref())
    .bind(ip.as_deref())
    .bind(ua.as_deref())
    .execute(pool)
    .await
    {
        warn!(target: "auth", error = ?err, action = event.action, "audit_logs insert failed");
    }

    append_user_action_log(serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "actor_user_id": event.actor_user_id,
        "organization_id": organization_id,
        "action": event.action,
        "resource_type": event.resource_type,
        "resource_id": event.resource_id,
        "metadata": event.metadata,
        "ip": ip,
        "user_agent": ua,
    }))
    .await;
}

async fn append_user_action_log(event: serde_json::Value) {
    let line = match serde_json::to_string(&event) {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = tokio::fs::create_dir_all(USER_ACTIONS_LOG_DIR).await;
    if let Ok(mut file) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(USER_ACTIONS_LOG_PATH)
        .await
        && let Err(err) = file.write_all(format!("{line}\n").as_bytes()).await
    {
        warn!(target: "auth", error = ?err, "user_actions.log write failed");
    }
}
