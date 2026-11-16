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

        let method = req.method().clone();
        let path = req.path().to_string();
        let ip = crate::client_ip::client_ip(req.request());
        // Never record the ingest path itself; it would log itself on every
        // page view and click.
        let skip = method == Method::OPTIONS || path.starts_with("/api/activity");

        Box::pin(async move {
            let res = srv.call(req).await?;
            // Resolve the actor AFTER the inner services ran. In Actix the last
            // `.wrap()` is outermost, so this middleware runs before
            // ApiKeyMiddleware; reading `res.request()` sees the
            // ApiKeyPrincipal it injected, whatever the wrap order.
            let user_id = get_user_id_from_request(res.request());
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

#[cfg(test)]
mod tests {
    use super::ActivityLogMiddleware;
    use crate::activity::test_capture;
    use crate::cache::Cache;
    use crate::middleware::api_key::ApiKeyMiddleware;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, HttpResponse, http::StatusCode, test as actix_test, web};
    use wayve_security::api_key::hash_api_key;

    async fn ok() -> HttpResponse {
        HttpResponse::Ok().finish()
    }

    /// Wraps the two middlewares in the same order as `main.rs`, so this fails
    /// if the activity log runs before the API-key principal is injected.
    #[actix_web::test]
    #[serial_test::serial]
    async fn logs_api_key_and_jwt_requests_as_their_user() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        // Unique per run so a key left by an earlier failed run can't collide.
        let raw = format!("wv_sk_activity_log_test_{}", uuid::Uuid::new_v4().simple());
        let raw = raw.as_str();
        sqlx::query(
            "INSERT INTO api_keys
                 (user_id, name, key_hash, key_preview, key_type, scopes,
                  expires_at, rate_limit_per_min)
             VALUES ($1, 'activity test', $2, 'wv_sk_..._test', 'external',
                     ARRAY['notes:read'], NOW() + INTERVAL '1 hour', 120)",
        )
        .bind(user_id)
        .bind(hash_api_key(raw))
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert test key: {e}"));

        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .wrap(ActivityLogMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/api/notes", web::get().to(ok)),
        )
        .await;
        test_capture::take();

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .insert_header(("X-API-KEY", raw))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            test_capture::take(),
            vec![(user_id, "api_request", Some("/api/notes".to_string()))],
            "an API-key request must be logged as the key's user"
        );

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(user_id, &email)),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            test_capture::take(),
            vec![(user_id, "api_request", Some("/api/notes".to_string()))],
            "a JWT request must still be logged"
        );

        // Unauthenticated, and a rejected key: nothing is logged.
        for req in [
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .to_request(),
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .insert_header(("X-API-KEY", "wv_sk_no_such_key"))
                .to_request(),
        ] {
            let _ = actix_test::call_service(&app, req).await;
        }
        assert_eq!(test_capture::take(), vec![]);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
    }
}
