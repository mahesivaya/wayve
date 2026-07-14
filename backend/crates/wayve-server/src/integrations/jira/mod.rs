//! Jira Cloud integration: a per-user connection and Tasks-to-issue sync over
//! direct REST, with no MCP. It touches no chat or email E2E.

pub mod client;
pub mod handler;
pub mod mapping;
pub mod models;
pub mod sync;
pub mod webhook;

/// Authenticated `/api` endpoints: connection management and import.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}

/// The root-mounted, unauthenticated Jira webhook, secured by its own URL token.
pub fn public_routes(cfg: &mut actix_web::web::ServiceConfig) {
    webhook::routes(cfg);
}
