//! Slack integration, enterprise tier only. Connect a workspace via a bot token,
//! link Slack channels to Wayve channels, import history, and bridge Wayve
//! messages back out. Enterprise chat is not E2E, so the bridged content is
//! server-readable, which is what makes this possible at all.

pub mod client;
pub mod handler;
pub mod models;
pub mod sync;
pub mod webhook;

/// Authenticated `/api` endpoints, all enterprise-gated in the handler.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}

/// The root-mounted, unauthenticated Slack Events webhook, secured by Slack's
/// request signature.
pub fn public_routes(cfg: &mut actix_web::web::ServiceConfig) {
    webhook::routes(cfg);
}
