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

/// The caller's IP, honoring `X-Forwarded-For` via Actix's `ConnectionInfo`.
/// Returns `None` when the connection has no peer address (in-process tests).
#[allow(dead_code)]
pub fn client_ip(req: &HttpRequest) -> Option<String> {
    req.connection_info().realip_remote_addr().map(String::from)
}

/// The caller's `User-Agent`, or `None` if absent / not UTF-8.
#[allow(dead_code)]
pub fn user_agent(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
}
