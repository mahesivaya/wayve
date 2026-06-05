// Centralized error logging.
//
// Two write paths:
//   1. `POST /api/error-logs` — the browser posts JS errors, unhandled
//      rejections, and failed-API-call summaries here. Intentionally
//      auth-optional so we still capture errors that happen before login
//      or with a bad/expired token (the most useful failure modes). When
//      a valid bearer is present we attribute the log to that user.
//   2. `log_server_error` — call from any backend handler to record an
//      internal fault for the dashboard. Best-effort; never bubbles up.
//
// One read path:
//   * `GET /api/platform/error-logs` — gated by `logs:read` AND platform
//     scope. Paginated list with simple filters (source, severity, q).

use crate::prelude::*;
use chrono::{DateTime, Utc};
use tracing::{error, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const MESSAGE_MAX: usize = 4_000;
const STACK_MAX: usize = 16_000;
const URL_MAX: usize = 1_000;
const UA_MAX: usize = 500;
const METHOD_MAX: usize = 16;

#[derive(Deserialize)]
pub struct ErrorLogIngestBody {
    pub message: String,
    pub severity: Option<String>,
    pub stack: Option<String>,
    pub url: Option<String>,
    pub user_agent: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub status_code: Option<i32>,
    pub method: Option<String>,
    pub extra: Option<serde_json::Value>,
}

#[derive(Serialize, FromRow)]
pub struct ErrorLogRow {
    pub id: i64,
    pub source: String,
    pub user_id: Option<i32>,
    pub user_email: Option<String>,
    pub session_id: Option<String>,
    pub severity: String,
    pub message: String,
    pub stack: Option<String>,
    pub url: Option<String>,
    pub user_agent: Option<String>,
    pub request_id: Option<String>,
    pub status_code: Option<i32>,
    pub method: Option<String>,
    pub extra: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_string()
    } else {
        let mut s = value.to_string();
        s.truncate(max);
        s
    }
}

fn normalize_severity(value: Option<&str>) -> &'static str {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("warn") | Some("warning") => "warn",
        Some("info") => "info",
        _ => "error",
    }
}

#[post("/error-logs")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn ingest_client_error(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ErrorLogIngestBody>,
) -> AppResult {
    let message = body.message.trim();
    if message.is_empty() {
        return Err(AppError::BadRequest("message is required".into()));
    }

    // Best-effort identity. The endpoint accepts unauthenticated posts so
    // we still catch errors that happen before login or with a bad token.
    let user_id = get_user_id_from_request(&req);
    let severity = normalize_severity(body.severity.as_deref());

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO error_logs
            (source, user_id, session_id, severity, message, stack, url,
             user_agent, request_id, status_code, method, extra)
        VALUES ('client', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
    )
    .bind(user_id)
    .bind(body.session_id.as_deref().map(|v| truncate(v, 200)))
    .bind(severity)
    .bind(truncate(message, MESSAGE_MAX))
    .bind(body.stack.as_deref().map(|v| truncate(v, STACK_MAX)))
    .bind(body.url.as_deref().map(|v| truncate(v, URL_MAX)))
    .bind(body.user_agent.as_deref().map(|v| truncate(v, UA_MAX)))
    .bind(body.request_id.as_deref().map(|v| truncate(v, 128)))
    .bind(body.status_code)
    .bind(body.method.as_deref().map(|v| truncate(v, METHOD_MAX)))
    .bind(body.extra.clone())
    .execute(pool.get_ref())
    .await
    {
        // Never fail the client over a broken log write — the user's
        // actual workflow already failed once; double-fail is worse.
        warn!(target: "http", error = ?e, "error_logs insert failed");
    }

    Ok(HttpResponse::Accepted().json(serde_json::json!({ "ok": true })))
}

/// Server-side helper. Call from handlers that want a fault to show up on
/// the platform logs dashboard. Best-effort — failures are logged but
/// never returned, so the caller's normal error path is unchanged.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub async fn log_server_error(
    pool: &PgPool,
    user_id: Option<i32>,
    message: &str,
    request_id: Option<&str>,
    method: Option<&str>,
    url: Option<&str>,
    status_code: Option<i32>,
) {
    let res = sqlx::query(
        r#"
        INSERT INTO error_logs
            (source, user_id, severity, message, request_id, method, url, status_code)
        VALUES ('server', $1, 'error', $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(truncate(message, MESSAGE_MAX))
    .bind(request_id.map(|v| truncate(v, 128)))
    .bind(method.map(|v| truncate(v, METHOD_MAX)))
    .bind(url.map(|v| truncate(v, URL_MAX)))
    .bind(status_code)
    .execute(pool)
    .await;
    if let Err(e) = res {
        // dev.log only — don't recurse into error_logs.
        error!(target: "db", error = ?e, "log_server_error write failed");
    }
}

#[derive(Deserialize)]
pub struct ErrorLogQuery {
    pub source: Option<String>,
    pub severity: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
}

#[get("/platform/error-logs")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_error_logs(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ErrorLogQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::LogsRead).await {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };
    // Platform staff see all app logs; an organization owner/admin sees only
    // logs attributed to their own org's members. Personal scope has none.
    let org_filter: Option<i32> = match ctx.scope {
        Scope::Platform => None,
        Scope::Organization => ctx.organization_id,
        Scope::Personal => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Platform or organization scope required"
            })));
        }
    };

    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let source = query
        .source
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let severity = query
        .severity
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let q = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| format!("%{v}%"));

    let rows = sqlx::query_as::<_, ErrorLogRow>(
        r#"
        SELECT l.id, l.source, l.user_id,
               u.email AS user_email,
               l.session_id, l.severity, l.message, l.stack, l.url,
               l.user_agent, l.request_id, l.status_code, l.method,
               l.extra, l.created_at
        FROM error_logs l
        LEFT JOIN users u ON u.id = l.user_id
        WHERE ($1::TEXT IS NULL OR l.source   = $1)
          AND ($2::TEXT IS NULL OR l.severity = $2)
          AND ($3::TEXT IS NULL OR l.message ILIKE $3 OR l.url ILIKE $3
                                OR u.email   ILIKE $3)
          AND ($5::INT IS NULL OR l.user_id IN (
                  SELECT id FROM users WHERE organization_id = $5))
        ORDER BY l.created_at DESC
        LIMIT $4
        "#,
    )
    .bind(source)
    .bind(severity)
    .bind(q)
    .bind(limit)
    .bind(org_filter)
    .fetch_all(pool.get_ref())
    .await?;

    // Quick aggregate stats so the dashboard can render a header strip
    // without a second round-trip.
    let stats = sqlx::query(
        r#"
        SELECT
            COUNT(*)                              FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::BIGINT AS errors_24h,
            COUNT(*)                              FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour' )::BIGINT AS errors_1h,
            COUNT(*) FILTER (WHERE source='client' AND created_at >= NOW() - INTERVAL '24 hours')::BIGINT AS client_24h,
            COUNT(*) FILTER (WHERE source='server' AND created_at >= NOW() - INTERVAL '24 hours')::BIGINT AS server_24h,
            COUNT(DISTINCT user_id)               FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND user_id IS NOT NULL)::BIGINT AS users_24h
        FROM error_logs
        WHERE ($1::INT IS NULL OR user_id IN (
                SELECT id FROM users WHERE organization_id = $1))
        "#,
    )
    .bind(org_filter)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "logs": rows,
        "stats": {
            "errors_1h":  stats.try_get::<i64, _>("errors_1h").unwrap_or(0),
            "errors_24h": stats.try_get::<i64, _>("errors_24h").unwrap_or(0),
            "client_24h": stats.try_get::<i64, _>("client_24h").unwrap_or(0),
            "server_24h": stats.try_get::<i64, _>("server_24h").unwrap_or(0),
            "users_24h":  stats.try_get::<i64, _>("users_24h").unwrap_or(0),
        },
    })))
}
