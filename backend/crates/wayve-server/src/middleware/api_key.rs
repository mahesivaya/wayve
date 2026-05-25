//! API key authentication middleware.
//!
//! Activates only when a request carries an `X-API-KEY` header — normal
//! JWT/cookie requests pass straight through untouched. For an API-key request
//! it validates the key, enforces the route's required scope and the key's
//! per-key rate limit, injects an `ApiKeyPrincipal` into the request extensions
//! (so `get_user_id_from_request` and every handler see the acting user), and
//! records the outcome in the API-key audit log.

use crate::cache::Cache;
use wayve_security::api_key::{
    ApiKeyPrincipal, AuditEntry, AuditOutcome, AuthFailure, required_scope, resolve_api_key,
    scope_satisfied, write_audit,
};
use actix_web::{
    Error, HttpMessage, HttpResponse,
    body::EitherBody,
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    web,
};
use futures::future::{LocalBoxFuture, Ready, ok};
use sqlx::PgPool;
use std::{
    rc::Rc,
    task::{Context, Poll},
};
use tracing::{error, warn};

const API_KEY_HEADER: &str = "X-API-KEY";

pub struct ApiKeyMiddleware;

fn deny(status: u16, message: &str) -> HttpResponse {
    let body = serde_json::json!({ "message": message });
    match status {
        401 => HttpResponse::Unauthorized().json(body),
        403 => HttpResponse::Forbidden().json(body),
        429 => HttpResponse::TooManyRequests().json(body),
        _ => HttpResponse::InternalServerError().json(body),
    }
}

/// Record one API-key request outcome without blocking the response.
fn audit(pool: &PgPool, entry: AuditEntry) {
    let pool = pool.clone();
    tokio::spawn(async move {
        write_audit(&pool, &entry).await;
    });
}

impl<S, B> Transform<S, ServiceRequest> for ApiKeyMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Transform = ApiKeyService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(ApiKeyService {
            service: Rc::new(service),
        })
    }
}

pub struct ApiKeyService<S> {
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for ApiKeyService<S>
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
        // Fast path: no API key header → behave as if this middleware is absent.
        let raw_key = req
            .headers()
            .get(API_KEY_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());

        let srv = self.service.clone();

        let Some(raw_key) = raw_key else {
            return Box::pin(async move {
                srv.call(req).await.map(ServiceResponse::map_into_left_body)
            });
        };

        Box::pin(async move {
            let Some(pool) = req.app_data::<web::Data<PgPool>>().cloned() else {
                error!(target: "api_key", "api key middleware missing pool app_data");
                return Ok(req.into_response(
                    HttpResponse::InternalServerError()
                        .finish()
                        .map_into_right_body(),
                ));
            };
            let pool = pool.get_ref().clone();

            let method = req.method().as_str().to_string();
            let path = req.path().to_string();
            let ip = req
                .connection_info()
                .realip_remote_addr()
                .map(|value| value.to_string());

            // Builds an audit row for this request; only the outcome varies.
            let make_entry = |api_key_id: Option<i32>,
                              user_id: Option<i32>,
                              status_code: i32,
                              outcome: AuditOutcome| AuditEntry {
                api_key_id,
                user_id,
                method: method.clone(),
                path: path.clone(),
                status_code,
                outcome,
                ip: ip.clone(),
            };

            // 1. Validate the key itself.
            let resolved = match resolve_api_key(&pool, &raw_key).await {
                Ok(key) => key,
                Err(failure) => {
                    let outcome = match failure {
                        AuthFailure::Invalid => AuditOutcome::Invalid,
                        AuthFailure::Revoked => AuditOutcome::DeniedRevoked,
                        AuthFailure::Expired => AuditOutcome::DeniedExpired,
                    };
                    audit(&pool, make_entry(None, None, 401, outcome));
                    return Ok(req.into_response(
                        deny(401, "Invalid, revoked, or expired API key").map_into_right_body(),
                    ));
                }
            };

            // 2. The route must be in scope for this key.
            let in_scope = required_scope(&method, &path)
                .map(|scope| scope_satisfied(&resolved.scopes, scope))
                .unwrap_or(false);
            if !in_scope {
                audit(
                    &pool,
                    make_entry(
                        Some(resolved.id),
                        Some(resolved.user_id),
                        403,
                        AuditOutcome::DeniedScope,
                    ),
                );
                return Ok(req.into_response(
                    deny(403, "API key is not permitted for this endpoint").map_into_right_body(),
                ));
            }

            // 3. Rate limit + monthly quota. Both fail open if Redis is
            //    unavailable — availability beats strictness for the data
            //    API. The *effective* rate limit is the MIN of the key's own
            //    cap and the plan-tier cap, so issuing a key with
            //    `rate_limit_per_min = 6000` on a Free plan still caps at
            //    the plan's 60/min — the operator can't accidentally give
            //    away the farm. The monthly quota aggregates across every
            //    key belonging to the same user, so spreading load across
            //    multiple keys does not bypass the plan budget.
            if let Some(cache_data) = req.app_data::<web::Data<Option<Cache>>>()
                && let Some(cache) = cache_data.get_ref().clone()
            {
                let tier = crate::billing::quotas::effective_for_user(&pool, resolved.user_id).await;
                let effective_rl =
                    i32::min(resolved.rate_limit_per_min, tier.rate_limit_per_min);

                let rl_key = format!("apikey_rl:{}", resolved.id);
                match cache.increment_with_ttl(&rl_key, 60).await {
                    Ok(count) if count > i64::from(effective_rl) => {
                        audit(
                            &pool,
                            make_entry(
                                Some(resolved.id),
                                Some(resolved.user_id),
                                429,
                                AuditOutcome::RateLimited,
                            ),
                        );
                        return Ok(req.into_response(
                            deny(429, "API key rate limit exceeded").map_into_right_body(),
                        ));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(target: "api_key", error = ?e, "rate limit check failed; allowing");
                    }
                }

                // Monthly quota. -1 = unlimited (enterprise).
                if tier.monthly_quota >= 0 {
                    let q_key = crate::billing::quotas::monthly_quota_key(resolved.user_id);
                    let ttl = crate::billing::quotas::monthly_quota_ttl_secs();
                    match cache.increment_with_ttl(&q_key, ttl).await {
                        Ok(count) if count > i64::from(tier.monthly_quota) => {
                            audit(
                                &pool,
                                make_entry(
                                    Some(resolved.id),
                                    Some(resolved.user_id),
                                    429,
                                    AuditOutcome::RateLimited,
                                ),
                            );
                            return Ok(req.into_response(
                                deny(
                                    429,
                                    "Monthly request quota exceeded for this plan. Upgrade or wait for the next cycle.",
                                )
                                .map_into_right_body(),
                            ));
                        }
                        Ok(_) => {}
                        Err(e) => {
                            warn!(target: "api_key", error = ?e, "quota check failed; allowing");
                        }
                    }
                }
            }

            // 4. Inject the acting principal so handlers authenticate as the
            //    key's user.
            let key_id = resolved.id;
            let user_id = resolved.user_id;
            req.extensions_mut().insert(ApiKeyPrincipal {
                user_id,
                key_id,
                key_type: resolved.key_type,
                scopes: resolved.scopes,
            });

            // 5. Run the handler, then record the outcome.
            let res = srv.call(req).await?;
            let status = i32::from(res.status().as_u16());
            audit(
                &pool,
                make_entry(Some(key_id), Some(user_id), status, AuditOutcome::Allowed),
            );
            Ok(res.map_into_left_body())
        })
    }
}
