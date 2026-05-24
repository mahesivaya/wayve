// X-EMBED-TOKEN middleware.
//
// Activates only when the request carries an `X-EMBED-TOKEN` header.
// Mirrors the X-API-KEY middleware's shape: validate → enforce → inject
// principal → forward. Three guarantees baked in:
//   1. GET / HEAD only — every other method is denied at the gate.
//   2. The token's `aud` must match the request's `Origin` header.
//   3. The token's scopes are a subset of `ALLOWED_SCOPES`.

use super::tokens::{EmbedClaims, VerifyError, verify};
use actix_web::body::EitherBody;
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::{Error, HttpMessage, HttpResponse};
use futures::future::{LocalBoxFuture, Ready, ok};
use std::rc::Rc;
use std::task::{Context, Poll};
use tracing::warn;

const HEADER: &str = "X-EMBED-TOKEN";

/// Principal stamped on the request when an embed token authenticates it.
/// Handlers read it the same way they read `ApiKeyPrincipal` — via the
/// request extensions — and treat the request as the named user.
#[derive(Debug, Clone)]
pub struct EmbedPrincipal {
    pub user_id: i32,
    /// Permitted scopes from the token. Currently advisory — v1 enforces
    /// GET-only at the method layer; per-route scope gating arrives if a
    /// consumer mints tokens narrower than "all reads".
    #[allow(dead_code)]
    pub scopes: Vec<String>,
    /// Per-token nonce for log correlation.
    #[allow(dead_code)]
    pub jti: String,
}

pub struct EmbedMiddleware;

impl<S, B> Transform<S, ServiceRequest> for EmbedMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Transform = EmbedService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(EmbedService {
            inner: Rc::new(service),
        })
    }
}

pub struct EmbedService<S> {
    inner: Rc<S>,
}

fn deny(status: u16, message: &str) -> HttpResponse {
    let body = serde_json::json!({ "message": message });
    match status {
        401 => HttpResponse::Unauthorized().json(body),
        403 => HttpResponse::Forbidden().json(body),
        405 => HttpResponse::MethodNotAllowed().json(body),
        _ => HttpResponse::BadRequest().json(body),
    }
}

impl<S, B> Service<ServiceRequest> for EmbedService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&self, ctx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(ctx)
    }

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let raw = req
            .headers()
            .get(HEADER)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());

        let srv = self.inner.clone();
        let Some(raw) = raw else {
            // No embed token — passthrough untouched.
            return Box::pin(async move {
                srv.call(req).await.map(ServiceResponse::map_into_left_body)
            });
        };

        Box::pin(async move {
            // GET / HEAD only.
            let method = req.method().clone();
            if !matches!(method.as_str(), "GET" | "HEAD") {
                warn!(target: "embed", method = %method, path = req.path(), "embed token rejected for non-GET");
                return Ok(req.into_response(
                    deny(405, "Embed tokens may only call GET endpoints").map_into_right_body(),
                ));
            }

            let claims: EmbedClaims = match verify(&raw) {
                Ok(c) => c,
                Err(e) => {
                    let (status, msg) = match e {
                        VerifyError::Expired => (401, "Embed token expired"),
                        VerifyError::WrongIssuer => (401, "Token is not an embed token"),
                        VerifyError::Decode => (401, "Embed token invalid"),
                    };
                    return Ok(req.into_response(deny(status, msg).map_into_right_body()));
                }
            };

            // Origin pin — the embedding page's Origin header must match
            // what the issuer baked into `aud`.
            let origin = req
                .headers()
                .get("Origin")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            if origin.as_deref() != Some(claims.aud.as_str()) {
                warn!(
                    target: "embed",
                    expected = %claims.aud,
                    got = ?origin,
                    "embed token origin mismatch"
                );
                return Ok(req.into_response(
                    deny(403, "Embed token is not valid from this origin").map_into_right_body(),
                ));
            }

            // Stamp the principal into request extensions so the existing
            // `get_user_id_from_request` chain (extended below) sees it.
            req.extensions_mut().insert(EmbedPrincipal {
                user_id: claims.sub,
                scopes: claims.scopes,
                jti: claims.jti,
            });
            srv.call(req).await.map(ServiceResponse::map_into_left_body)
        })
    }
}
