//! Platform-wide UI settings (platform owner only).
//!
//! Currently just the app-wide font family. The chosen `font_key` is stored on
//! the `platform_ui_config` singleton and served to every client via the public
//! `GET /api/config` (see `routes::config`); this module only lets the platform
//! owner read and change it. The frontend maps the key to a CSS font stack — we
//! store and validate a short allowlisted key here, never a raw CSS string.

use crate::ai::config_handler::require_platform_owner;
use crate::prelude::*;
use actix_web::put;
use tracing::{info, instrument};
use wayve_security::jwt::get_user_id_from_request;

/// Font keys the frontend knows how to render. Keep in sync with
/// `frontend/src/theme/platformFonts.ts`. `system` (or absent) = app default.
const FONT_KEYS: &[&str] = &["system", "inter", "ibm-plex", "serif", "mono"];

#[derive(Deserialize)]
struct UiConfigPayload {
    /// `None` or `"system"` clears the override (back to the app default).
    font_key: Option<String>,
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_ui_config).service(put_ui_config);
}

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

    // `system`/empty means "no override" → store NULL; validate anything else.
    let font_key: Option<String> = match body.font_key.as_deref().map(str::trim) {
        None | Some("") | Some("system") => None,
        Some(key) if FONT_KEYS.contains(&key) => Some(key.to_string()),
        Some(_) => return Err(AppError::bad_request("Unknown font")),
    };

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

    info!(target: "worker", user_id, font_key = ?font_key, "platform ui font updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "font_key": font_key })))
}
