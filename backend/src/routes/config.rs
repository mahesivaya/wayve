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
    }))
}
