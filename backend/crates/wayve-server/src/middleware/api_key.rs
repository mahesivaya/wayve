//! API key authentication middleware.
//!
//! This is a no-op unless the request carries an `X-API-KEY` header: JWT and
//! cookie requests pass straight through. For an API-key request it validates
//! the key, enforces the route's `required_scope(method, path)` and the key's
//! rate limit, records the outcome in the audit log, and injects an
//! `ApiKeyPrincipal` into the request extensions. `get_user_id_from_request`
//! returns that principal, so a key authenticates as its designated `user_id`
//! and every handler works unchanged.

use crate::cache::Cache;
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
use wayve_security::api_key::{
    ApiKeyPrincipal, AuditEntry, AuditOutcome, AuthFailure, required_scope, resolve_api_key,
    scope_satisfied, write_audit,
};

const API_KEY_HEADER: &str = "X-API-KEY";

/// The credential this middleware resolves — a service key or an OAuth token.
enum Credential {
    ApiKey(String),
    OAuth(String),
}

/// The acting identity a credential resolves to, normalized across both kinds.
struct Acting {
    /// The api_keys row id for audit, or `None` for OAuth (no api_keys FK).
    audit_key_id: Option<i32>,
    /// A stable id for the rate-limit cache bucket.
    rate_bucket: String,
    user_id: i32,
    key_type: String,
    scopes: Vec<String>,
    /// The credential's own per-minute cap, if any (OAuth relies on plan tier).
    own_rate_limit: Option<i32>,
}

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
        // Two credentials flow through here. An `X-API-KEY` header is a service
        // API key. An `Authorization: Bearer wv_oat_*` is an OAuth access token
        // (a session JWT has no such prefix, so it passes straight through to
        // the JWT path downstream). Either resolves to an ApiKeyPrincipal.
        let raw_key = req
            .headers()
            .get(API_KEY_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let oauth_token = req
            .headers()
            .get(actix_web::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| token.starts_with(crate::oauth_provider::OAUTH_TOKEN_PREFIX))
            .map(|token| token.to_string());

        let srv = self.service.clone();

        let Some(credential) = raw_key
            .map(Credential::ApiKey)
            .or_else(|| oauth_token.map(Credential::OAuth))
        else {
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

            let acting = match credential {
                Credential::ApiKey(raw_key) => match resolve_api_key(&pool, &raw_key).await {
                    Ok(key) => Acting {
                        audit_key_id: Some(key.id),
                        rate_bucket: format!("apikey_rl:{}", key.id),
                        user_id: key.user_id,
                        key_type: key.key_type,
                        scopes: key.scopes,
                        own_rate_limit: Some(key.rate_limit_per_min),
                    },
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
                },
                Credential::OAuth(raw_token) => {
                    match crate::oauth_provider::resolve_oauth_token(&pool, &raw_token).await {
                        Some((user_id, scopes)) => Acting {
                            audit_key_id: None,
                            rate_bucket: format!("oauth_rl:{user_id}"),
                            user_id,
                            key_type: "oauth".to_string(),
                            scopes,
                            // OAuth tokens have no per-token cap; the plan tier governs.
                            own_rate_limit: None,
                        },
                        None => {
                            audit(&pool, make_entry(None, None, 401, AuditOutcome::Invalid));
                            return Ok(req.into_response(
                                deny(401, "Invalid, revoked, or expired access token")
                                    .map_into_right_body(),
                            ));
                        }
                    }
                }
            };

            // The route's required scope must be satisfied by the credential.
            let in_scope = required_scope(&method, &path)
                .map(|scope| scope_satisfied(&acting.scopes, scope))
                .unwrap_or(false);
            if !in_scope {
                audit(
                    &pool,
                    make_entry(
                        acting.audit_key_id,
                        Some(acting.user_id),
                        403,
                        AuditOutcome::DeniedScope,
                    ),
                );
                return Ok(req.into_response(
                    deny(403, "Credential is not permitted for this endpoint")
                        .map_into_right_body(),
                ));
            }

            // Rate limit and monthly quota both fail open when Redis is down.
            // The effective rate limit is the minimum of the credential's own cap
            // (API keys only) and the plan-tier cap, so it can never exceed the
            // plan. The monthly quota aggregates across all of the user's
            // credentials, so spreading load over several does not bypass it.
            if let Some(cache_data) = req.app_data::<web::Data<Option<Cache>>>()
                && let Some(cache) = cache_data.get_ref().clone()
            {
                let tier = crate::billing::quotas::effective_for_user(&pool, acting.user_id).await;
                let effective_rl = match acting.own_rate_limit {
                    Some(cap) => i32::min(cap, tier.rate_limit_per_min),
                    None => tier.rate_limit_per_min,
                };

                match cache.increment_with_ttl(&acting.rate_bucket, 60).await {
                    Ok(count) if count > i64::from(effective_rl) => {
                        audit(
                            &pool,
                            make_entry(
                                acting.audit_key_id,
                                Some(acting.user_id),
                                429,
                                AuditOutcome::RateLimited,
                            ),
                        );
                        return Ok(req.into_response(
                            deny(429, "Rate limit exceeded").map_into_right_body(),
                        ));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(target: "api_key", error = ?e, "rate limit check failed; allowing");
                    }
                }

                // A negative quota means unlimited (enterprise).
                if tier.monthly_quota >= 0 {
                    let q_key = crate::billing::quotas::monthly_quota_key(acting.user_id);
                    let ttl = crate::billing::quotas::monthly_quota_ttl_secs();
                    match cache.increment_with_ttl(&q_key, ttl).await {
                        Ok(count) if count > i64::from(tier.monthly_quota) => {
                            audit(
                                &pool,
                                make_entry(
                                    acting.audit_key_id,
                                    Some(acting.user_id),
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

            // Inject the acting principal so handlers authenticate as the
            // credential's user. `key_id` is 0 for OAuth (no api_keys row).
            let audit_key_id = acting.audit_key_id;
            let user_id = acting.user_id;
            req.extensions_mut().insert(ApiKeyPrincipal {
                user_id,
                key_id: audit_key_id.unwrap_or(0),
                key_type: acting.key_type,
                scopes: acting.scopes,
            });

            let res = srv.call(req).await?;
            let status = i32::from(res.status().as_u16());
            audit(
                &pool,
                make_entry(audit_key_id, Some(user_id), status, AuditOutcome::Allowed),
            );
            Ok(res.map_into_left_body())
        })
    }
}
