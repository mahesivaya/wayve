//! UI settings — the app-wide font, resolved per scope.
//!
//! Three levels store a short allowlisted `font_key`, never raw CSS:
//! `users.ui_font_key`, `organizations.ui_font_key`, and
//! `platform_ui_config.font_key`. `resolve_font_key` picks the user's own, then
//! their org's, then the platform default, then NULL. The platform value is also
//! served unauthenticated via `GET /api/config` as the pre-login font. The
//! frontend maps a key to a CSS stack (`theme/platformFonts.ts`).

use crate::ai::config_handler::require_platform_owner;
use crate::prelude::*;
use actix_web::put;
use tracing::{info, instrument};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Role, Scope, resolve_role_context_moded};

/// Font keys the frontend knows how to render. Keep in sync with
/// `frontend/src/theme/platformFonts.ts`. `system` (or absent) = app default.
const FONT_KEYS: &[&str] = &["system", "inter", "ibm-plex", "serif", "mono"];

#[derive(Deserialize)]
struct UiConfigPayload {
    /// `None` or `"system"` clears the override (inherit the next level).
    font_key: Option<String>,
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_ui_config)
        .service(put_ui_config)
        .service(get_font)
        .service(put_my_font)
        .service(put_org_font);
}

/// Normalize + validate an incoming key: `system`/empty → `None` (inherit),
/// a known key → `Some(key)`, anything else → 400.
fn normalize_font(input: &Option<String>) -> Result<Option<String>, AppError> {
    match input.as_deref().map(str::trim) {
        None | Some("") | Some("system") => Ok(None),
        Some(key) if FONT_KEYS.contains(&key) => Ok(Some(key.to_string())),
        Some(_) => Err(AppError::bad_request("Unknown font")),
    }
}

/// The font a user actually gets: their own > their org's > the platform default.
async fn resolve_font_key(pool: &PgPool, user_id: i32) -> Result<Option<String>, AppError> {
    let row = sqlx::query(
        "SELECT COALESCE(u.ui_font_key, o.ui_font_key, p.font_key) AS font_key
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN platform_ui_config p ON p.id = 1
          WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|r| r.try_get::<Option<String>, _>("font_key").ok().flatten()))
}

/// The caller's org if they are its **owner** (any tier), else `Forbidden`.
async fn require_org_owner(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<i32, AppError> {
    let ctx = resolve_role_context_moded(req, pool, user_id)
        .await
        .map_err(AppError::from)?;
    if ctx.scope == Scope::Organization && ctx.role == Role::Owner {
        ctx.organization_id.ok_or(AppError::Forbidden)
    } else {
        Err(AppError::Forbidden)
    }
}

/// The caller's resolved font plus each level's raw value, for the editor.
#[get("/ui/font")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_font(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let row = sqlx::query(
        "SELECT u.ui_font_key AS user_font,
                o.ui_font_key AS org_font,
                p.font_key     AS platform_font
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN platform_ui_config p ON p.id = 1
          WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let user_font = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("user_font").ok().flatten());
    let org_font = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("org_font").ok().flatten());
    let platform_font = row.as_ref().and_then(|r| {
        r.try_get::<Option<String>, _>("platform_font")
            .ok()
            .flatten()
    });
    let resolved = user_font
        .clone()
        .or_else(|| org_font.clone())
        .or_else(|| platform_font.clone());

    // Which levels the caller may edit.
    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id)
        .await
        .map_err(AppError::from)?;
    let can_set_org = ctx.scope == Scope::Organization && ctx.role == Role::Owner;
    let can_set_platform = ctx.scope == Scope::Platform && ctx.role == Role::Owner;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "resolved": resolved,
        "user": user_font,
        "org": org_font,
        "platform": platform_font,
        "can_set_org": can_set_org,
        "can_set_platform": can_set_platform,
    })))
}

/// Set or clear the caller's own font override.
#[put("/ui/font/me")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_my_font(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<UiConfigPayload>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let font_key = normalize_font(&body.font_key)?;

    sqlx::query("UPDATE users SET ui_font_key = $1 WHERE id = $2")
        .bind(&font_key)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    let resolved = resolve_font_key(pool.get_ref(), user_id).await?;
    info!(target: "worker", user_id, font_key = ?font_key, "user ui font updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "user": font_key, "resolved": resolved })))
}

/// Set or clear the org-wide font. Org owner only; applies to every member
/// without their own override.
#[put("/ui/font/org")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_org_font(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<UiConfigPayload>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = require_org_owner(&req, pool.get_ref(), user_id).await?;
    let font_key = normalize_font(&body.font_key)?;

    sqlx::query("UPDATE organizations SET ui_font_key = $1 WHERE id = $2")
        .bind(&font_key)
        .bind(org_id)
        .execute(pool.get_ref())
        .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "org_ui.font_update",
            resource_type: "organization",
            resource_id: Some(org_id.to_string()),
            metadata: Some(serde_json::json!({ "font_key": font_key })),
        },
    )
    .await;

    let resolved = resolve_font_key(pool.get_ref(), user_id).await?;
    info!(target: "worker", user_id, org_id, font_key = ?font_key, "org ui font updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "org": font_key, "resolved": resolved })))
}

/// The platform-wide default font. Platform owner only.
#[get("/platform/ui-config")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_ui_config(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    require_platform_owner(&req, pool.get_ref(), user_id).await?;

    let font_key: Option<String> =
        sqlx::query("SELECT font_key FROM platform_ui_config WHERE id = 1")
            .fetch_optional(pool.get_ref())
            .await?
            .and_then(|row| row.try_get::<Option<String>, _>("font_key").ok().flatten());

    Ok(HttpResponse::Ok().json(serde_json::json!({ "font_key": font_key })))
}

#[put("/platform/ui-config")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_ui_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<UiConfigPayload>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    require_platform_owner(&req, pool.get_ref(), user_id).await?;
    let font_key = normalize_font(&body.font_key)?;

    sqlx::query(
        "INSERT INTO platform_ui_config (id, font_key, updated_by, updated_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE
            SET font_key = EXCLUDED.font_key,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()",
    )
    .bind(&font_key)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "platform_ui.update",
            resource_type: "platform_ui_config",
            resource_id: Some("platform".to_string()),
            metadata: Some(serde_json::json!({ "font_key": font_key })),
        },
    )
    .await;

    let resolved = resolve_font_key(pool.get_ref(), user_id).await?;
    info!(target: "worker", user_id, font_key = ?font_key, "platform ui font updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "platform": font_key, "resolved": resolved })))
}
