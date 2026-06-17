//! Records every authenticated API request into the `activity_events` stream
//! (the "non-consequential" audit). Unauthenticated traffic (health checks,
//! login, static assets), CORS preflight, and the activity ingest endpoint
//! itself are skipped. The DB write is fire-and-forget so request latency is
//! unaffected.

use actix_web::{
    Error,
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    http::Method,
    web,
};
use futures::future::{LocalBoxFuture, Ready, ok};
use sqlx::PgPool;
use std::{
    rc::Rc,
    task::{Context, Poll},
};
use wayve_security::jwt::get_user_id_from_request;

pub struct ActivityLogMiddleware;

impl<S, B> Transform<S, ServiceRequest> for ActivityLogMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Transform = ActivityLogService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(ActivityLogService {
            service: Rc::new(service),
        })
    }
}

pub struct ActivityLogService<S> {
    service: Rc<S>,
}

impl<S, B> Service<ServiceRequest> for ActivityLogService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&self, ctx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.service.poll_ready(ctx)
    }

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let srv = self.service.clone();

        // Resolve request facts up front (all cheap, no DB hit). user_id comes
        // from the JWT/cookie or an api-key principal already injected upstream.
        let method = req.method().clone();
        let path = req.path().to_string();
        let user_id = get_user_id_from_request(req.request());
        let ip = req.connection_info().realip_remote_addr().map(String::from);
        let pool = req
            .app_data::<web::Data<PgPool>>()
            .map(|p| p.get_ref().clone());

        // Only record attributable, non-preflight requests; never the ingest
        // path (would record itself on every page view / click).
        let skip = method == Method::OPTIONS
            || path.starts_with("/api/activity")
            || user_id.is_none()
            || pool.is_none();

        Box::pin(async move {
            let res = srv.call(req).await?;
            if !skip && let (Some(uid), Some(pool)) = (user_id, pool) {
                crate::activity::spawn_record(
                    pool,
                    uid,
                    "api_request",
                    None,
                    Some(method.to_string()),
                    Some(path),
                    Some(i32::from(res.status().as_u16())),
                    ip,
                );
            }
            Ok(res)
        })
    }
}
