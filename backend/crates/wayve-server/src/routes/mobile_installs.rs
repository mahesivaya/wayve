//! Mobile app install tracking.
//!
//! App Store installs are invisible to us, so the app reports itself: on every
//! launch it sends `POST /api/mobile/installs` with a random install id it
//! generated on first launch (kept in the app's storage, so deleting and
//! reinstalling the app counts as a new install). The first report from an id
//! creates the row; later ones bump `last_seen_at` and `launches`, which gives
//! "active" counts too. Signed-in launches attach the user.
//!
//! The endpoint is public (the app reports before sign-in), so new ids from one
//! IP are capped per hour; a script cannot inflate the count without bound.
//! Recording is best-effort and always answers 204.
//!
//! `GET /api/platform/mobile-installs` gives platform staff the totals, the
//! per-platform / channel / version / location counts, and the latest installs.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::{DateTime, Utc};
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const PLATFORMS: &[&str] = &["ios", "android"];
const CHANNELS: &[&str] = &["app_store", "testflight", "debug"];
const FIELD_MAX: usize = 64;
/// New install ids accepted from one IP per hour.
const NEW_PER_IP_PER_HOUR: i64 = 20;
const RECENT_DEFAULT_LIMIT: i64 = 100;
const RECENT_MAX_LIMIT: i64 = 500;
const LOCATIONS_LIMIT: i64 = 100;

#[derive(Deserialize)]
pub struct InstallReport {
    pub install_id: String,
    pub platform: String,
    pub channel: Option<String>,
    pub app_version: Option<String>,
    pub build: Option<String>,
    pub os_version: Option<String>,
    pub device_model: Option<String>,
}

fn clean(value: Option<String>) -> Option<String> {
    let v = value?.trim().to_string();
    if v.is_empty() {
        return None;
    }
    // Back off to a char boundary so a multi-byte value cannot panic truncate.
    let mut end = v.len().min(FIELD_MAX);
    while !v.is_char_boundary(end) {
        end -= 1;
    }
    Some(v[..end].to_string())
}

#[post("/mobile/installs")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn report_mobile_install(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<InstallReport>,
) -> AppResult {
    let body = body.into_inner();
    let Ok(install_id) = uuid::Uuid::parse_str(body.install_id.trim()) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "install_id must be a UUID"
        })));
    };
    let platform = body.platform.trim().to_lowercase();
    if !PLATFORMS.contains(&platform.as_str()) {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Unknown platform"
        })));
    }
    let channel = clean(body.channel)
        .map(|c| c.to_lowercase())
        .filter(|c| CHANNELS.contains(&c.as_str()));
    let install_id = install_id.to_string();
    let app_version = clean(body.app_version);
    let build = clean(body.build);
    let os_version = clean(body.os_version);
    let device_model = clean(body.device_model);
    let user_id = get_user_id_from_request(&req);
    let db = pool.get_ref();

    // A known install: refresh it.
    let updated = sqlx::query(
        r#"
        UPDATE mobile_installs
        SET last_seen_at = NOW(),
            launches = launches + 1,
            channel = COALESCE($2, channel),
            app_version = COALESCE($3, app_version),
            build = COALESCE($4, build),
            os_version = COALESCE($5, os_version),
            device_model = COALESCE($6, device_model),
            user_id = COALESCE($7, user_id)
        WHERE install_id = $1
        "#,
    )
    .bind(&install_id)
    .bind(channel.as_deref())
    .bind(app_version.as_deref())
    .bind(build.as_deref())
    .bind(os_version.as_deref())
    .bind(device_model.as_deref())
    .bind(user_id)
    .execute(db)
    .await;

    match updated {
        Ok(r) if r.rows_affected() > 0 => {}
        Ok(_) => {
            // A new install, unless this IP already registered too many this hour.
            // IP comes from the connection (trusted-proxy aware), never the body.
            let ip = crate::audit::client_ip(&req);
            let geo = crate::audit::resolve_geo(&req, ip.as_deref());
            if let Err(e) = sqlx::query(
                r#"
                INSERT INTO mobile_installs
                    (install_id, platform, channel, app_version, build, os_version,
                     device_model, user_id, ip, country, region, city)
                SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                WHERE (
                    SELECT COUNT(*) FROM mobile_installs
                    WHERE ip = $9 AND first_seen_at > NOW() - INTERVAL '1 hour'
                ) < $13
                ON CONFLICT (install_id) DO NOTHING
                "#,
            )
            .bind(&install_id)
            .bind(&platform)
            .bind(channel.as_deref())
            .bind(app_version.as_deref())
            .bind(build.as_deref())
            .bind(os_version.as_deref())
            .bind(device_model.as_deref())
            .bind(user_id)
            .bind(ip)
            .bind(geo.country.as_deref())
            .bind(geo.region.as_deref())
            .bind(geo.city.as_deref())
            .bind(NEW_PER_IP_PER_HOUR)
            .execute(db)
            .await
            {
                warn!(target: "http", error = ?e, "mobile_installs insert failed");
            }
        }
        Err(e) => warn!(target: "http", error = ?e, "mobile_installs update failed"),
    }

    Ok(HttpResponse::NoContent().finish())
}

#[derive(Deserialize)]
pub struct StatsQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct KeyCount {
    /// Null for installs that did not report this field.
    pub key: Option<String>,
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
pub struct InstallRow {
    pub id: i64,
    pub platform: String,
    pub channel: Option<String>,
    pub app_version: Option<String>,
    pub build: Option<String>,
    pub os_version: Option<String>,
    pub device_model: Option<String>,
    pub user_id: Option<i32>,
    pub user_email: Option<String>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub launches: i32,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct Totals {
    total: i64,
    active_30_days: i64,
    new_30_days: i64,
}

#[derive(Serialize)]
pub struct InstallStats {
    pub total: i64,
    /// Installs that launched in the last 30 days.
    pub active_30_days: i64,
    /// Installs first seen in the last 30 days.
    pub new_30_days: i64,
    pub by_platform: Vec<KeyCount>,
    pub by_channel: Vec<KeyCount>,
    pub by_version: Vec<KeyCount>,
    pub by_location: Vec<LocationCount>,
    pub recent: Vec<InstallRow>,
}

async fn count_by(db: &PgPool, column: &str) -> Result<Vec<KeyCount>, sqlx::Error> {
    // `column` is one of the fixed names below, never caller input.
    sqlx::query_as::<_, KeyCount>(&format!(
        "SELECT {column} AS key, COUNT(*)::BIGINT AS count FROM mobile_installs \
         GROUP BY {column} ORDER BY count DESC, {column} NULLS LAST"
    ))
    .fetch_all(db)
    .await
}

#[get("/platform/mobile-installs")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn mobile_install_stats(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<StatsQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::AuditRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    // Installs are platform-wide, like desktop downloads and site visits.
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
               (COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '30 days'))::BIGINT
                   AS active_30_days,
               (COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '30 days'))::BIGINT
                   AS new_30_days
        FROM mobile_installs
        "#,
    )
    .fetch_one(db)
    .await?;

    let by_platform = count_by(db, "platform").await?;
    let by_channel = count_by(db, "channel").await?;
    let by_version = count_by(db, "app_version").await?;

    let by_location = sqlx::query_as::<_, LocationCount>(
        r#"
        SELECT country, region, city, COUNT(*)::BIGINT AS count
        FROM mobile_installs
        GROUP BY country, region, city
        ORDER BY count DESC, country NULLS LAST, region NULLS LAST, city NULLS LAST
        LIMIT $1
        "#,
    )
    .bind(LOCATIONS_LIMIT)
    .fetch_all(db)
    .await?;

    let recent = sqlx::query_as::<_, InstallRow>(
        r#"
        SELECT m.id, m.platform, m.channel, m.app_version, m.build, m.os_version,
               m.device_model, m.user_id, u.email AS user_email, m.ip,
               m.country, m.region, m.city, m.launches, m.first_seen_at, m.last_seen_at
        FROM mobile_installs m
        LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.first_seen_at DESC, m.id DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(db)
    .await?;

    Ok(HttpResponse::Ok().json(InstallStats {
        total: totals.total,
        active_30_days: totals.active_30_days,
        new_30_days: totals.new_30_days,
        by_platform,
        by_channel,
        by_version,
        by_location,
        recent,
    }))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(report_mobile_install)
        .service(mobile_install_stats);
}
