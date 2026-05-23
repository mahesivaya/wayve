// ==============================
// 🔹 INTERNAL MODULES (declare first)
// ==============================
mod ai;
mod billing;
mod cache;
mod call;
mod chat;
mod config;
mod drive;
mod email;
mod error;
mod external;
mod middleware;
mod models;
mod notes;
mod observability;
mod prelude;
mod routes;
mod scheduler;
pub mod security;
mod startup;
mod tasks;
mod workers;
mod ws_registry;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

// ==============================
// 🔹 USE INTERNAL MODULES
// ==============================
use crate::observability::tracing::init_tracing;
// 🚧 use crate::observability::tracing_root::AppRootSpanBuilder; // disabled

use crate::config::{RuntimeRole, database_url, db_max_connections, listen_port, load_env_files};
use crate::email::body_worker::run_body_worker;
use crate::middleware::api_key::ApiKeyMiddleware;
use crate::middleware::rate_limit::RateLimitMiddleware;
use crate::workers::run_sync_worker;

// ==============================
// 🔹 EXTERNAL CRATES
// ==============================
use actix_cors::Cors;
use actix_web::{App, HttpServer, web};
pub use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::postgres::PgPoolOptions;
use tokio::time::Duration;

use tracing::{info, warn};
use tracing_actix_web::TracingLogger;

fn app_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // 🔥 GROUP API ROUTES
        .service(
            web::scope("/api")
                .configure(routes::routes)
                .configure(email::routes)
                .configure(chat::routes)
                .configure(scheduler::routes)
                .configure(drive::routes)
                .configure(notes::routes)
                .configure(tasks::routes)
                .configure(call::api_routes)
                .configure(ai::routes)
                .configure(billing::routes),
        )
        // 🔥 AUTH / GOOGLE
        .configure(email::public_routes)
        // 🔥 STRIPE WEBHOOK (unauthenticated, signature-verified)
        .configure(billing::public_routes)
        // 🔥 WEBSOCKETS
        .configure(chat::ws_routes)
        .configure(call::routes);
    // NOTE: uploaded files are no longer served statically from /uploads.
    // They are delivered via the authenticated, ownership-checked route
    // GET /api/files/{id}/download (see drive::handler::download_file).
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    init_tracing();
    load_env_files();
    crate::config::validate();
    info!("Server starting...");
    tracing::info!("Server starting...");
    let role = RuntimeRole::from_env();
    info!(?role, "Runtime role selected");

    // Explicit DATABASE_URL wins; otherwise derived from the POSTGRES_* parts
    // so the credentials are single-sourced in .env.secrets.
    let db_url = database_url();
    let max_db_connections = db_max_connections(role);
    info!(max_db_connections, "Database pool size selected");
    // Log the first failure verbosely; subsequent identical failures get a
    // compact dot-counter so dev.log doesn't fill with the same line.
    let pool = {
        let mut attempts: u32 = 0;
        loop {
            match PgPoolOptions::new()
                .max_connections(max_db_connections)
                .connect(&db_url)
                .await
            {
                Ok(pool) => {
                    if attempts > 0 {
                        info!("Connected to Postgres after {} retries", attempts);
                    } else {
                        info!("Connected to Postgres");
                    }
                    break pool;
                }
                Err(e) => {
                    if attempts == 0 {
                        warn!("Postgres unavailable, retrying... ({e:?})");
                    } else if attempts.is_power_of_two() {
                        warn!("Postgres still unavailable after {} retries", attempts);
                    }
                    attempts += 1;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    };

    crate::startup::ensure_email_schema(&pool).await;

    match role {
        RuntimeRole::EmailSyncWorker => run_sync_worker(pool).await,
        RuntimeRole::EmailBodyWorker => run_body_worker(pool).await,
        RuntimeRole::All => {
            let sync_pool = pool.clone();
            tokio::spawn(async move {
                run_sync_worker(sync_pool).await;
            });
            let body_pool = pool.clone();
            tokio::spawn(async move {
                run_body_worker(body_pool).await;
            });
            let billing_pool = pool.clone();
            tokio::spawn(async move {
                billing::spawn_billing_worker(billing_pool).await;
            });
        }
        RuntimeRole::Api => {}
    }

    let redis_cache = match crate::cache::Cache::connect().await {
        Ok(c) => {
            info!("Connected to Redis");
            Some(c)
        }
        Err(e) => {
            warn!("Redis unavailable, caching disabled ({e:?})");
            None
        }
    };

    let frontend_url = crate::config::frontend_url();

    let port = listen_port();
    info!(port, "Listen port selected");

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin(&frontend_url)
            .allowed_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS"])
            .allowed_headers(vec![
                actix_web::http::header::CONTENT_TYPE,
                actix_web::http::header::AUTHORIZATION,
                actix_web::http::header::HeaderName::from_static("x-request-id"),
            ])
            .expose_headers(vec![actix_web::http::header::HeaderName::from_static(
                "x-has-more",
            )])
            .supports_credentials();

        App::new()
            .wrap(TracingLogger::default()) // 🚧
            .wrap(ApiKeyMiddleware)
            .wrap(RateLimitMiddleware)
            .wrap(cors)
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::Data::new(redis_cache.clone()))
            .configure(app_routes)
    })
    .bind(("0.0.0.0", port))?;

    info!("Server started on :{port}");

    let res = server.run().await;
    info!("Server shutdown complete");
    res
}
