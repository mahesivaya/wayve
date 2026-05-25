//! Public runtime configuration for the browser.
//!
//! Served unauthenticated so the frontend can fetch its API / WebSocket base
//! and other public settings at boot — which makes a single frontend build
//! environment-agnostic (no rebuild to point at a different host).

use crate::config;
use actix_web::{HttpResponse, Responder, get};

#[get("/config")]
pub async fn public_config() -> impl Responder {
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
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
