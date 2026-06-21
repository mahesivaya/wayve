//! Jira Cloud integration: per-user connection + Tasks ↔ Jira issue sync.
//! Direct REST (no MCP); touches no chat/email E2E. See
//! `docs/architecture/adding-a-feature.md` for the module conventions.

pub mod client;
pub mod handler;
pub mod mapping;
pub mod models;
pub mod sync;
pub mod webhook;

/// Authenticated, `/api`-scoped endpoints (connection management + import).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}

/// Root-mounted, unauthenticated receiver: the inbound Jira webhook
/// (`/webhooks/fluxze_webhook`), secured by its own URL token.
pub fn public_routes(cfg: &mut actix_web::web::ServiceConfig) {
    webhook::routes(cfg);
}
