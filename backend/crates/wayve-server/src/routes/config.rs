//! Public runtime configuration for the browser.
//!
//! Served unauthenticated so the frontend can fetch its API / WebSocket base
//! and other public settings at boot — which makes a single frontend build
//! environment-agnostic (no rebuild to point at a different host).

use crate::config;
use actix_web::{HttpResponse, Responder, get, web};
use sqlx::{PgPool, Row};

#[get("/config")]
pub async fn public_config(pool: web::Data<PgPool>) -> impl Responder {
    // Platform-wide UI font, chosen by the platform owner and applied to every
    // client (incl. the pre-login page). Best-effort — a missing table/row just
    // means the app default. Set via `platform_ui`.
    let font_key: Option<String> =
        sqlx::query("SELECT font_key FROM platform_ui_config WHERE id = 1")
            .fetch_optional(pool.get_ref())
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<Option<String>, _>("font_key").ok().flatten());

    HttpResponse::Ok().json(serde_json::json!({
        "api_base": config::public_api_url(),
        "ws_base": config::public_ws_url(),
        "stripe_publishable_key": config::stripe().publishable_key,
        "environment": config::app_environment(),
        "auth": {
            "google_client_id": std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            "allow_registration": std::env::var("ALLOW_REGISTRATION").map(|v| v == "true").unwrap_or(true),
        },
        "features": {
            "ai_chat_enabled": std::env::var("ENABLE_AI_CHAT").map(|v| v == "true").unwrap_or(false),
            "e2ee_enabled": true,
        },
        "ui": {
            "font_key": font_key,
        },
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Register this domain's routes. Called from `routes::routes` (the aggregator).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(public_config);
}
