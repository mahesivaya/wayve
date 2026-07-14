pub mod access_requests;
pub mod account;
pub mod activity;
pub mod api_keys;
pub mod audit;
pub mod auth;
pub mod chat_keys;
pub mod config;
pub mod email;
pub mod error_logs;
pub mod health;
pub mod recovery;
pub mod shared_inbox;
pub mod sso;
pub mod support;
pub mod tracing;
pub mod user;
pub mod visits;

/// Aggregator for the cross-cutting core-platform routes, mounted under `/api`
/// from `routing.rs`. Each domain owns its own `routes()` in its submodule, so a
/// new endpoint touches only that submodule.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    health::routes(cfg);
    config::routes(cfg);
    auth::routes(cfg);
    user::routes(cfg);
    api_keys::routes(cfg);
    audit::routes(cfg);
    activity::routes(cfg);
    account::routes(cfg);
    sso::routes(cfg);
    shared_inbox::routes(cfg);
    recovery::routes(cfg);
    access_requests::routes(cfg);
    support::routes(cfg);
    error_logs::routes(cfg);
    visits::routes(cfg);
    chat_keys::routes(cfg);
    tracing::routes(cfg);
}
