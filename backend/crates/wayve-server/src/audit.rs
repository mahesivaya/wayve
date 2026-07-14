//! Shared building blocks for audit-log inserts.
//!
//! Each audit table has its own column shape, so the `INSERT` itself stays in the
//! owning module. What is shared is the request-derived context — caller IP and
//! User-Agent — which every audit writer can pull from `audit::client_ip` and
//! `audit::user_agent`.

use actix_web::{HttpRequest, web};
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::warn;

use crate::geoip::{GeoIp, GeoLocation};

/// Geolocate `ip` using the shared GeoIP reader from request app state.
/// Best-effort: the empty location when there is no IP, no reader configured, or
/// the lookup misses.
pub(crate) fn resolve_geo(req: &HttpRequest, ip: Option<&str>) -> GeoLocation {
    let Some(ip) = ip else {
        return GeoLocation::default();
    };
    match req
        .app_data::<web::Data<Option<GeoIp>>>()
        .map(web::Data::get_ref)
    {
        Some(Some(geo)) => geo.lookup(ip),
        _ => GeoLocation::default(),
    }
}

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

const USER_ACTIONS_LOG_DIR: &str = "logs";
const USER_ACTIONS_LOG_PATH: &str = "logs/user_actions.log";

/// A security-relevant action a user took (password change, deletion, export,
/// billing change). Grouped into a struct to keep `record_action` under the
/// clippy argument threshold.
pub struct AuditEvent<'a> {
    pub actor_user_id: i32,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Record a user action to `audit_logs` and `user_actions.log`. Best-effort on
/// both sinks: a logging failure is warned and swallowed so it never blocks the
/// action being audited.
pub async fn record_action(pool: &PgPool, req: &HttpRequest, event: AuditEvent<'_>) {
    let ip = client_ip(req);
    let ua = user_agent(req);
    let geo = resolve_geo(req, ip.as_deref());
    record(pool, event, ip, ua, geo).await;
}

/// Like [`record_action`] but for events with no originating HTTP request, such
/// as the sync worker recording `email_received`. IP and User-Agent are NULL.
pub async fn record_action_system(pool: &PgPool, event: AuditEvent<'_>) {
    record(pool, event, None, None, GeoLocation::default()).await;
}

/// A plan change, entitlement grant, or subscription transition. These mostly
/// arrive from Stripe webhooks (no HTTP request) and are owned by either a user
/// or an organization, so neither [`record_action`] nor [`record_action_system`]
/// fits: both owner ids are given explicitly and either may be NULL.
pub struct BillingAuditEvent<'a> {
    pub actor_user_id: Option<i32>,
    pub organization_id: Option<i32>,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

/// Record a billing audit event so it appears on the Security and User Logs pages
/// alongside every other audited action. Best-effort on both sinks: a logging
/// failure must never block the billing state change or make Stripe retry it.
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

/// Record a failed login attempt. The actor may be unknown (a login for a
/// non-existent email), so the actor id is optional and the attempted email plus
/// failure `reason` go in metadata. Best-effort; never blocks the 401.
pub async fn record_login_failure(
    pool: &PgPool,
    req: &HttpRequest,
    email: &str,
    reason: &str,
    actor_user_id: Option<i32>,
) {
    let ip = client_ip(req);
    let ua = user_agent(req);
    let geo = resolve_geo(req, ip.as_deref());

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
             resource_id, metadata, ip, user_agent, country, region, city)
        VALUES ($1, $2, 'login_failed', 'session', NULL, $3::jsonb, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(actor_user_id)
    .bind(organization_id)
    .bind(&metadata_text)
    .bind(ip.as_deref())
    .bind(ua.as_deref())
    .bind(geo.country.as_deref())
    .bind(geo.region.as_deref())
    .bind(geo.city.as_deref())
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
        "country": geo.country,
        "region": geo.region,
        "city": geo.city,
    }))
    .await;
}

/// Shared writer: inserts the `audit_logs` row and mirrors it to
/// `logs/user_actions.log`. Both sinks are best-effort.
async fn record(
    pool: &PgPool,
    event: AuditEvent<'_>,
    ip: Option<String>,
    ua: Option<String>,
    geo: GeoLocation,
) {
    // Denormalized so the scoped reads on the Security page need no live join.
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
             resource_id, metadata, ip, user_agent, country, region, city)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
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
    .bind(geo.country.as_deref())
    .bind(geo.region.as_deref())
    .bind(geo.city.as_deref())
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
        "country": geo.country,
        "region": geo.region,
        "city": geo.city,
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
