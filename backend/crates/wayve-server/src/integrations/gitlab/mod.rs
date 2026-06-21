//! GitLab integration: per-user connection + GitLab issues → Tasks import.
//! Direct REST (PAT), per-user (not enterprise-gated), self-hosted supported.
//! Mirrors the Jira module; see `docs/architecture/adding-a-feature.md`.

pub mod client;
pub mod handler;
pub mod mapping;
pub mod models;
pub mod sync;

/// Authenticated, `/api`-scoped endpoints (connection management + import).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
