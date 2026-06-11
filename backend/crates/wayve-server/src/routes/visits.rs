//! Visitor tracking — records every open of the public site (including
//! anonymous visitors) and exposes a platform-admin list.
//!
//! Mirrors the anonymous error-log beacon (`routes/error_logs.rs`): the
//! `POST /api/visits` endpoint is auth-optional and best-effort, capturing the
//! client IP + user-agent **server-side** (never trusted from the body).

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::{DateTime, Utc};
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const PATH_MAX: usize = 1_000;
const REFERRER_MAX: usize = 1_000;
const UA_MAX: usize = 500;
const VISITS_DEFAULT_LIMIT: i64 = 100;
const VISITS_MAX_LIMIT: i64 = 500;

#[derive(Deserialize)]
pub struct VisitIngestBody {
    pub path: String,
    pub referrer: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct VisitRow {
    pub id: i64,
    pub user_id: Option<i32>,
    pub user_email: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub path: String,
    pub referrer: Option<String>,
    pub created_at: DateTime<Utc>,
    // Coarse geolocation of `ip`, resolved offline at write time. NULL for
    // older rows and private/unresolvable IPs.
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
}

#[derive(Deserialize)]
pub struct VisitQuery {
    pub limit: Option<i64>,
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

// POST /api/visits — record a public-site page open. Anonymous allowed;
// best-effort (a failed write never fails the visitor's request).
#[post("/visits")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn ingest_page_visit(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<VisitIngestBody>,
) -> AppResult {
    let trimmed = body.path.trim();
    let path = if trimmed.is_empty() { "/" } else { trimmed };

    // Best-effort identity — NULL for anonymous visitors.
    let user_id = get_user_id_from_request(&req);
    // IP + user-agent are read server-side (X-Forwarded-For aware), never
    // trusted from the client body.
    let ip = crate::audit::client_ip(&req);
    let user_agent = crate::audit::user_agent(&req).map(|v| truncate(&v, UA_MAX));
    // Resolve coarse geolocation offline (same path as audit logs) so the
    // Visitors page can show a Location column. Best-effort: NULL when there's
    // no IP / no GeoIP reader / the lookup misses.
    let geo = crate::audit::resolve_geo(&req, ip.as_deref());

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO page_visits (user_id, ip, user_agent, path, referrer, country, region, city)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(user_id)
    .bind(ip)
    .bind(user_agent)
    .bind(truncate(path, PATH_MAX))
    .bind(body.referrer.as_deref().map(|v| truncate(v, REFERRER_MAX)))
    .bind(geo.country.as_deref())
    .bind(geo.region.as_deref())
    .bind(geo.city.as_deref())
    .execute(pool.get_ref())
    .await
    {
        warn!(target: "http", error = ?e, "page_visits insert failed");
    }

    Ok(HttpResponse::Accepted().json(serde_json::json!({ "ok": true })))
}

// GET /api/platform/visits — platform-admin list of recent site visits.
#[get("/platform/visits")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_page_visits(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<VisitQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::AuditRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    // Site traffic is platform-wide; only platform staff may view it.
    match ctx.scope {
        Scope::Platform => {}
        _ => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Platform scope required"
            })));
        }
    }

    let limit = query
        .limit
        .unwrap_or(VISITS_DEFAULT_LIMIT)
        .clamp(1, VISITS_MAX_LIMIT);

    let rows = sqlx::query_as::<_, VisitRow>(
        r#"
        SELECT v.id, v.user_id, u.email AS user_email, v.ip, v.user_agent,
               v.path, v.referrer, v.created_at, v.country, v.region, v.city
        FROM page_visits v
        LEFT JOIN users u ON u.id = v.user_id
        ORDER BY v.created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

/// Register this domain's routes. Called from `routes::routes` (the aggregator).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(ingest_page_visit).service(list_page_visits);
}
