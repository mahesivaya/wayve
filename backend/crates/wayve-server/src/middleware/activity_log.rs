//! Records every authenticated API request into the `activity_events` stream,
//! the non-consequential audit. Unauthenticated traffic, CORS preflight, and
//! the activity ingest endpoint itself are skipped. The row goes onto the
//! bounded queue in `crate::activity`, so the request never waits on, or holds,
//! a DB connection for it.

use actix_web::{
    Error,
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    http::Method,
};
use futures::future::{LocalBoxFuture, Ready, ok};
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

        // user_id comes from the JWT/cookie or an api-key principal already
        // injected upstream.
        let method = req.method().clone();
        let path = req.path().to_string();
        let user_id = get_user_id_from_request(req.request());
        let ip = crate::client_ip::client_ip(req.request());
        // Never record the ingest path itself; it would log itself on every
        // page view and click.
        let skip = method == Method::OPTIONS || path.starts_with("/api/activity");

        Box::pin(async move {
            let res = srv.call(req).await?;
            if !skip && let Some(uid) = user_id {
                let mut row = crate::activity::ActivityRow::new(uid, "api_request");
                row.method = Some(method.to_string());
                row.path = Some(path);
                row.status_code = Some(i32::from(res.status().as_u16()));
                row.ip = ip;
                crate::activity::enqueue(row);
            }
            Ok(res)
        })
    }
}
