mod activity;
mod ai;
mod audit;
mod auth_extractor;
mod billing;
mod cache;
mod call;
mod chat;
mod config;
mod db;
mod demo;
mod directory_scope;
mod docs;
mod documents;
mod drive;
mod email;
mod embed;
mod encryption_policy;
mod error;
mod external;
mod feature_access;
mod figma;
mod geoip;
mod github_oauth;
mod github_pr_notify;
mod github_proxy;
mod home;
mod integrations;
mod middleware;
mod models;
mod notes;
mod oauth_provider;
mod observability;
mod openapi;
mod organization;
mod pagination;
mod platform_billing;
mod platform_team;
mod platform_ui;
mod prelude;
mod rbac_cache;
mod reminders;
mod repo_access;
mod routes;
mod routing;
mod scheduler;
mod scim;
mod slack_oauth;
mod startup;
mod storage;
mod tasks;
mod tickets;
mod user_stories;
mod webhooks;
mod workers;
mod workspace;
mod ws_registry;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use actix_web::{App, HttpServer, web};
pub use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tracing::info;
use tracing_actix_web::TracingLogger;

use crate::config::{RuntimeRole, listen_port};
use crate::middleware::activity_log::ActivityLogMiddleware;
use crate::middleware::api_key::ApiKeyMiddleware;
use crate::middleware::rate_limit::RateLimitMiddleware;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    startup::init_telemetry();

    let role = RuntimeRole::from_env();
    info!(?role, "Runtime role selected");

    let pool = startup::connect_db_and_migrate(role).await;
    startup::init_feature_state(&pool);
    // Redis must connect before the workers spawn so `spawn_role_workers` can gate
    // the chat pub/sub subscriber on its availability. Worker-only roles block
    // forever inside that call, so everything below it runs on the API/All roles.
    let redis_cache = startup::connect_redis_and_install_cache().await;
    startup::spawn_role_workers(role, &pool, &redis_cache).await;

    // The GeoIP reader isn't `Clone`, so build the shared `web::Data` once and
    // clone the handle into each worker.
    let geoip_data = web::Data::new(startup::load_geoip());

    let frontend_url = crate::config::frontend_url();
    let port = listen_port();
    info!(port, "Listen port selected");

    let server = HttpServer::new(move || {
        App::new()
            .wrap(TracingLogger::default())
            .wrap(ApiKeyMiddleware)
            // Must follow ApiKeyMiddleware so an api-key request's principal is
            // already injected when the activity stream resolves the actor.
            .wrap(ActivityLogMiddleware)
            .wrap(embed::middleware::EmbedMiddleware)
            .wrap(RateLimitMiddleware)
            .wrap(startup::build_cors(&frontend_url))
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::Data::new(redis_cache.clone()))
            .app_data(geoip_data.clone())
            .configure(routing::wire)
    })
    .bind(("0.0.0.0", port))?;

    info!("Server started on :{port}");

    let res = server.run().await;
    info!("Server shutdown complete");
    res
}
