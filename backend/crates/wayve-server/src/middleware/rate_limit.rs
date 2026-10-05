use crate::cache::Cache;
use actix_web::body::EitherBody;
use actix_web::{
    Error, HttpResponse,
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    web,
};
use futures::future::{LocalBoxFuture, Ready, ok};
use std::{
    rc::Rc,
    task::{Context, Poll},
};
use tracing::{error, warn};

pub struct RateLimitMiddleware;

#[derive(Clone, Copy)]
struct LimitRule {
    max_requests: i64,
    window_secs: u64,
}

fn auth_limit_rule(method: &str, path: &str) -> Option<LimitRule> {
    if method != "POST" {
        return None;
    }

    match path {
        "/api/login" => Some(LimitRule {
            max_requests: 10,
            window_secs: 60,
        }),
        // Called once per login attempt, before /api/login; looser than login
        // so a typo-and-retry doesn't trip it first.
        "/api/auth/prelogin" => Some(LimitRule {
            max_requests: 30,
            window_secs: 60,
        }),
        "/api/register" => Some(LimitRule {
            max_requests: 5,
            window_secs: 300,
        }),
        "/api/forgot-password" => Some(LimitRule {
            max_requests: 5,
            window_secs: 900,
        }),
        // Anonymous visit beacon: generous, but bounded to deter abuse.
        "/api/visits" => Some(LimitRule {
            max_requests: 120,
            window_secs: 60,
        }),
        _ => None,
    }
}

/// Bucketed per client IP. The IP must not be client-choosable, or rotating a
/// forged `X-Forwarded-For` gets a fresh bucket per request (see `client_ip`).
fn client_key(req: &ServiceRequest) -> String {
    let ip = crate::client_ip::client_ip(req.request()).unwrap_or_else(|| "unknown".to_string());

    format!("rl:{}:{}:{}", req.method(), req.path(), ip)
}

impl<S, B> Transform<S, ServiceRequest> for RateLimitMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Transform = RateLimitService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(RateLimitService {
            service: Rc::new(service),
        })
    }
}

pub struct RateLimitService<S> {
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for RateLimitService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&self, ctx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.service.poll_ready(ctx)
    }

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let Some(rule) = auth_limit_rule(req.method().as_str(), req.path()) else {
            let srv = self.service.clone();
            return Box::pin(async move {
                srv.call(req).await.map(ServiceResponse::map_into_left_body)
            });
        };

        let Some(cache_data) = req.app_data::<web::Data<Option<Cache>>>() else {
            warn!(target: "rate_limit", path = req.path(), "rate limiter missing cache app_data");
            return Box::pin(async {
                Ok(req.into_response(
                    HttpResponse::ServiceUnavailable()
                        .body("Rate limiter unavailable")
                        .map_into_right_body(),
                ))
            });
        };

        let Some(cache) = cache_data.get_ref().clone() else {
            warn!(target: "rate_limit", path = req.path(), "redis unavailable; auth endpoint blocked");
            return Box::pin(async {
                Ok(req.into_response(
                    HttpResponse::ServiceUnavailable()
                        .body("Rate limiter unavailable")
                        .map_into_right_body(),
                ))
            });
        };

        let key = client_key(&req);
        let srv = self.service.clone();

        Box::pin(async move {
            let count = match cache.increment_with_ttl(&key, rule.window_secs).await {
                Ok(count) => count,
                Err(e) => {
                    error!(target: "rate_limit", key, error = ?e, "redis rate limit check failed");
                    return Ok(req.into_response(
                        HttpResponse::ServiceUnavailable()
                            .body("Rate limiter unavailable")
                            .map_into_right_body(),
                    ));
                }
            };

            if count > rule.max_requests {
                return Ok(req.into_response(
                    HttpResponse::TooManyRequests()
                        .body("Rate limit exceeded")
                        .map_into_right_body(),
                ));
            }

            srv.call(req).await.map(ServiceResponse::map_into_left_body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, HttpResponse, http::StatusCode, test as actix_test, web};

    fn key_for(peer: &str, forwarded_for: Option<&str>) -> String {
        let mut req = actix_test::TestRequest::post().uri("/api/login").peer_addr(
            format!("{peer}:40000")
                .parse()
                .unwrap_or_else(|e| panic!("peer: {e}")),
        );
        if let Some(value) = forwarded_for {
            req = req.insert_header(("X-Forwarded-For", value));
        }
        client_key(&req.to_srv_request())
    }

    #[test]
    fn forged_forwarded_for_from_the_internet_does_not_change_the_bucket() {
        let plain = key_for("203.0.113.9", None);
        assert_eq!(key_for("203.0.113.9", Some("1.1.1.1")), plain);
        assert_eq!(key_for("203.0.113.9", Some("2.2.2.2, 3.3.3.3")), plain);
        assert!(plain.ends_with(":203.0.113.9"));
    }

    #[test]
    fn behind_nginx_the_bucket_is_the_real_client() {
        // nginx on the Docker bridge network, overwriting XFF with $remote_addr.
        assert!(key_for("172.18.0.5", Some("198.51.100.7")).ends_with(":198.51.100.7"));
        // Even if a hop were appended to a forged value, the forged part is ignored.
        assert!(key_for("172.18.0.5", Some("6.6.6.6, 198.51.100.7")).ends_with(":198.51.100.7"));
    }

    /// End to end against Redis: rotating forged `X-Forwarded-For` values from
    /// one client used to get a fresh bucket per request. Skips without Redis.
    #[actix_web::test]
    async fn rotating_forwarded_for_still_hits_the_limit() {
        let Ok(cache) = Cache::connect().await else {
            eprintln!("Redis unavailable — skipping rate limit spoofing test");
            return;
        };
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(Some(cache)))
                .wrap(RateLimitMiddleware)
                .route("/api/register", web::post().to(HttpResponse::Ok)),
        )
        .await;

        // A fresh documentation-range client per run, so reruns inside the
        // 5-minute window don't share a bucket.
        let n = uuid::Uuid::new_v4().as_u128();
        let peer = format!("[2001:db8::{:x}:{:x}]:40000", (n >> 16) as u16, n as u16);
        let mut statuses = Vec::new();
        for i in 0..6 {
            let req = actix_test::TestRequest::post()
                .uri("/api/register")
                .peer_addr(peer.parse().unwrap_or_else(|e| panic!("peer: {e}")))
                .insert_header(("X-Forwarded-For", format!("10.9.8.{i}")))
                .to_request();
            statuses.push(actix_test::call_service(&app, req).await.status());
        }
        assert!(
            statuses[..5].iter().all(|s| *s == StatusCode::OK),
            "{statuses:?}"
        );
        assert_eq!(statuses[5], StatusCode::TOO_MANY_REQUESTS, "{statuses:?}");
    }

    #[test]
    fn only_limits_auth_mutation_routes() {
        assert!(auth_limit_rule("POST", "/api/login").is_some());
        assert!(auth_limit_rule("POST", "/api/register").is_some());
        assert!(auth_limit_rule("POST", "/api/forgot-password").is_some());
        assert!(auth_limit_rule("GET", "/api/login").is_none());
        assert!(auth_limit_rule("POST", "/api/files/upload").is_none());
    }

    #[actix_web::test]
    async fn auth_endpoint_fails_closed_without_redis_cache() {
        let app = actix_test::init_service(
            App::new()
                .wrap(RateLimitMiddleware)
                .route("/api/login", web::post().to(HttpResponse::Ok)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri("/api/login")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
