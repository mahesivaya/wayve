//! Desktop app download tracking.
//!
//! The site's "Download App" menu links to `GET /api/desktop/download/{build}`
//! rather than straight to S3. The handler records the download (anonymous
//! included) with the caller's IP, user-agent and offline-geolocated location,
//! then redirects to the installer. The same build from the same IP within ten
//! minutes is recorded once. Recording is best-effort: a failed insert
//! still sends the visitor to their download.
//!
//! `GET /api/platform/desktop-downloads` gives platform staff the totals, the
//! per-build and per-location counts, and the most recent downloads.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, get, web};
use chrono::{DateTime, Utc};
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

/// Where the installers live. The original `Fluxze-arm64/x64.dmg` objects are
/// write-locked, so current builds publish under these keys
/// (see `frontend/src/utils/desktop.ts`).
const DOWNLOADS_BASE: &str = "https://fluxze-desktop-downloads.s3.us-east-1.amazonaws.com";

/// `(build key, installer file)`. The key is what gets stored, so renaming the
/// file does not split the counts.
const BUILDS: &[(&str, &str)] = &[
    ("mac-arm64", "Fluxze-mac-arm64.dmg"),
    ("mac-x64", "Fluxze-mac-x64.dmg"),
];

const UA_MAX: usize = 500;
/// Repeats of the same build from the same IP within this many minutes are
/// recorded once.
const DEDUPE_WINDOW_MINS: i32 = 10;
const RECENT_DEFAULT_LIMIT: i64 = 100;
const RECENT_MAX_LIMIT: i64 = 500;
const LOCATIONS_LIMIT: i64 = 100;

fn installer_url(build: &str) -> Option<String> {
    BUILDS
        .iter()
        .find(|(key, _)| *key == build)
        .map(|(_, file)| format!("{DOWNLOADS_BASE}/{file}"))
}

fn truncate(value: &str, max: usize) -> String {
    let mut s = value.to_string();
    if s.len() > max {
        // Back off to a char boundary so a multi-byte UA cannot panic truncate.
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

#[get("/desktop/download/{build}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn download_desktop_app(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> AppResult {
    let build = path.into_inner();
    let Some(url) = installer_url(&build) else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "message": "Unknown desktop build"
        })));
    };

    // Signed-in visitors are attributed; everyone else is still counted.
    let user_id = get_user_id_from_request(&req);
    // IP and user-agent come from the connection (trusted-proxy aware, see
    // client_ip.rs), never from the client.
    let ip = crate::audit::client_ip(&req);
    let user_agent = crate::audit::user_agent(&req).map(|v| truncate(&v, UA_MAX));
    let geo = crate::audit::resolve_geo(&req, ip.as_deref());

    // The endpoint is public, so one IP repeating the same build inside the
    // window is recorded once: a double-click or a looping script cannot inflate
    // the count or grow the table without bound. The redirect happens anyway.
    // A NULL IP never matches, so those are always recorded.
    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO desktop_downloads (build, user_id, ip, user_agent, country, region, city)
        SELECT $1, $2, $3, $4, $5, $6, $7
        WHERE NOT EXISTS (
            SELECT 1 FROM desktop_downloads
            WHERE ip = $3 AND build = $1
              AND created_at > NOW() - make_interval(mins => $8)
        )
        "#,
    )
    .bind(&build)
    .bind(user_id)
    .bind(ip)
    .bind(user_agent)
    .bind(geo.country.as_deref())
    .bind(geo.region.as_deref())
    .bind(geo.city.as_deref())
    .bind(DEDUPE_WINDOW_MINS)
    .execute(pool.get_ref())
    .await
    {
        warn!(target: "http", error = ?e, "desktop_downloads insert failed");
    }

    // No caching, or a browser could replay the redirect without counting it.
    Ok(HttpResponse::Found()
        .insert_header(("Location", url))
        .insert_header(("Cache-Control", "no-store"))
        .finish())
}

#[derive(Deserialize)]
pub struct StatsQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct BuildCount {
    pub build: String,
    pub count: i64,
}

#[derive(Serialize, FromRow)]
pub struct LocationCount {
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub count: i64,
}

#[derive(Serialize, FromRow)]
pub struct DownloadRow {
    pub id: i64,
    pub build: String,
    pub user_id: Option<i32>,
    pub user_email: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, FromRow)]
struct Totals {
    total: i64,
    unique_ips: i64,
    last_30_days: i64,
}

#[derive(Serialize)]
pub struct DownloadStats {
    pub total: i64,
    /// Distinct IPs: a closer estimate of people than raw clicks.
    pub unique_ips: i64,
    pub last_30_days: i64,
    pub by_build: Vec<BuildCount>,
    /// Busiest locations first. A row with every field null is downloads whose
    /// IP could not be located.
    pub by_location: Vec<LocationCount>,
    pub recent: Vec<DownloadRow>,
}

#[get("/platform/desktop-downloads")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn desktop_download_stats(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<StatsQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::AuditRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    // Downloads are platform-wide traffic, like site visits.
    if !matches!(ctx.scope, Scope::Platform) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Platform scope required"
        })));
    }

    let limit = query
        .limit
        .unwrap_or(RECENT_DEFAULT_LIMIT)
        .clamp(1, RECENT_MAX_LIMIT);
    let db = pool.get_ref();

    let totals = sqlx::query_as::<_, Totals>(
        r#"
        SELECT COUNT(*)::BIGINT AS total,
               COUNT(DISTINCT ip)::BIGINT AS unique_ips,
               (COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'))::BIGINT
                   AS last_30_days
        FROM desktop_downloads
        "#,
    )
    .fetch_one(db)
    .await?;

    let by_build = sqlx::query_as::<_, BuildCount>(
        r#"
        SELECT build, COUNT(*)::BIGINT AS count
        FROM desktop_downloads
        GROUP BY build
        ORDER BY count DESC, build
        "#,
    )
    .fetch_all(db)
    .await?;

    let by_location = sqlx::query_as::<_, LocationCount>(
        r#"
        SELECT country, region, city, COUNT(*)::BIGINT AS count
        FROM desktop_downloads
        GROUP BY country, region, city
        ORDER BY count DESC, country NULLS LAST, region NULLS LAST, city NULLS LAST
        LIMIT $1
        "#,
    )
    .bind(LOCATIONS_LIMIT)
    .fetch_all(db)
    .await?;

    let recent = sqlx::query_as::<_, DownloadRow>(
        r#"
        SELECT d.id, d.build, d.user_id, u.email AS user_email, d.ip, d.user_agent,
               d.country, d.region, d.city, d.created_at
        FROM desktop_downloads d
        LEFT JOIN users u ON u.id = d.user_id
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(db)
    .await?;

    Ok(HttpResponse::Ok().json(DownloadStats {
        total: totals.total,
        unique_ips: totals.unique_ips,
        last_30_days: totals.last_30_days,
        by_build,
        by_location,
        recent,
    }))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(download_desktop_app)
        .service(desktop_download_stats);
}
