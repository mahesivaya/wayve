//! Slack integration (ENTERPRISE tier only). Connect a Slack workspace via a
//! bot token, link Slack channels to Wayve channels, import history inbound, and
//! bridge Wayve channel messages back out to Slack. Enterprise chat is not E2E,
//! so imported/bridged content is server-readable — which is what makes this
//! possible. See `docs/architecture/adding-a-feature.md` for module conventions.

pub mod client;
pub mod handler;
pub mod models;
pub mod sync;

/// Authenticated, `/api`-scoped endpoints (all enterprise-gated in the handler).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
