//! GitLab integration: a per-user connection and an issues-to-Tasks import over
//! direct REST with a PAT. Not enterprise-gated, and self-hosted instances are
//! supported. Mirrors the Jira module.

pub mod client;
pub mod handler;
pub mod mapping;
pub mod models;
pub mod sync;

/// Authenticated `/api` endpoints: connection management and import.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
