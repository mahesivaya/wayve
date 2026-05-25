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
        "/api/register" => Some(LimitRule {
            max_requests: 5,
            window_secs: 300,
        }),
        "/api/forgot-password" => Some(LimitRule {
            max_requests: 5,
            window_secs: 900,
        }),
        _ => None,
    }
}

fn client_key(req: &ServiceRequest) -> String {
    let ip = req
        .connection_info()
        .realip_remote_addr()
        .unwrap_or("unknown")
        .to_string();

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
