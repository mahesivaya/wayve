// ==============================
// INTERNAL MODULES (declare first)
// ==============================
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
mod docs;
mod documents;
mod drive;
mod email;
mod embed;
mod encryption_policy;
mod error;
mod external;
mod feature_access;
mod geoip;
mod github_proxy;
mod home;
mod integrations;
mod middleware;
mod models;
mod notes;
mod observability;
mod openapi;
mod organization;
mod pagination;
mod platform_billing;
mod platform_team;
mod prelude;
mod rbac_cache;
mod routes;
mod routing;
mod scheduler;
mod scim;
mod startup;
mod tasks;
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
    // Connect Redis before spawning workers so `spawn_role_workers` can gate the
    // chat pub/sub subscriber on Redis availability. (Worker-only roles block
    // forever inside `spawn_role_workers`, so everything below it is API/All.)
    let redis_cache = startup::connect_redis_and_install_cache().await;
    startup::spawn_role_workers(role, &pool, redis_cache.is_some()).await;

    // Offline IP geolocation for the User Logs page. Best-effort: `None` when
    // GEOIP_DB_PATH is unset/unreadable. The reader isn't `Clone`, so build the
    // shared `web::Data` (an `Arc`) once and clone the handle into each worker.
    let geoip_data = web::Data::new(startup::load_geoip());

    let frontend_url = crate::config::frontend_url();
    let port = listen_port();
    info!(port, "Listen port selected");

    let server = HttpServer::new(move || {
        App::new()
            .wrap(TracingLogger::default())
            .wrap(ApiKeyMiddleware)
            // After ApiKeyMiddleware so an api-key request's principal is already
            // injected when we resolve the actor for the activity stream.
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
