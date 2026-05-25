use crate::cache::Cache;
use crate::prelude::*;
use tracing::{instrument, warn};

/// Liveness probe — confirms the process is up and serving HTTP. It performs
/// no dependency checks on purpose, so a transient Postgres/Redis blip does
/// not make an orchestrator kill an otherwise-healthy container.
#[get("/health")]
pub async fn health() -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({ "status": "ok" }))
}

/// Readiness probe — confirms the process can serve real traffic: Postgres is
/// reachable and (when configured) Redis is reachable. Returns 503 when a
/// dependency is down so a load balancer stops routing until it recovers.
///
/// Redis is optional (`cache: None` when it failed to connect at startup), so
/// its absence is treated as ready — it only fails readiness when a configured
/// Redis stops responding.
#[get("/ready")]
#[instrument(target = "http", skip(pool, cache))]
pub async fn ready(pool: web::Data<PgPool>, cache: web::Data<Option<Cache>>) -> impl Responder {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool.get_ref())
        .await
        .is_ok();

    let redis_ok = match cache.get_ref() {
        Some(cache) => cache.ping().await,
        None => true,
    };

    let ready = db_ok && redis_ok;
    let body = serde_json::json!({
        "status": if ready { "ready" } else { "not ready" },
        "checks": { "database": db_ok, "redis": redis_ok },
    });

    if ready {
        HttpResponse::Ok().json(body)
    } else {
        warn!(target: "http", db_ok, redis_ok, "readiness check failed");
        HttpResponse::ServiceUnavailable().json(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, http::StatusCode, test};
    use sqlx::postgres::PgPoolOptions;

    #[actix_web::test]
    async fn health_returns_200_without_dependencies() {
        let app = test::init_service(App::new().service(health)).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[actix_web::test]
    async fn ready_returns_503_when_database_unreachable() {
        // Lazy pool aimed at a port nothing listens on: `SELECT 1` fails, so
        // readiness must report 503 rather than a connection panic.
        let pool = PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(500))
            .connect_lazy("postgres://nouser:nopass@127.0.0.1:1/nodb")
            .unwrap_or_else(|err| panic!("lazy pool: {err}"));
        let cache: Option<Cache> = None;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool))
                .app_data(web::Data::new(cache))
                .service(ready),
        )
        .await;

        let req = test::TestRequest::get().uri("/ready").to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
