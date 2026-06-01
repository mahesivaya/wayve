//! Auth chokepoints adapted to the `AppError` flow so handlers can use `?`
//! instead of the manual `match … { Err(resp) => return Ok(resp) }` dance.
//!
//! The underlying primitives live in `wayve_security`:
//!   * `jwt::get_user_id_from_request` — extracts a user id from JWT, API key,
//!     or session cookie.
//!   * `rbac::require_permission` — same idea but also resolves the role and
//!     enforces a `Permission`.
//!
//! Both return `Result<…, HttpResponse>`, which forces every adopting handler
//! to manually peel the `Err` branch into `return Ok(resp)`. The thin wrappers
//! here convert that into `Result<…, AppError>` so the `?` operator works.
//!
//! Existing handlers are unchanged. Adopt one of these in any new handler:
//! ```ignore
//! pub async fn my_handler(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
//!     let user_id = require_user(&req)?;
//!     // …
//! }
//! ```
//! Or:
//! ```ignore
//! pub async fn admin_only(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
//!     let ctx = require_permission_app(&req, &pool, Permission::FooManage).await?;
//!     // …
//! }
//! ```

use crate::error::AppError;
use actix_web::HttpRequest;
use sqlx::PgPool;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Permission, RoleContext, require_permission};

/// Pull a verified user id out of the request, or 401. Equivalent to the
/// hand-rolled `.ok_or(AppError::Unauthorized)?` that's repeated in 60+
/// handlers today.
#[allow(dead_code)]
pub fn require_user(req: &HttpRequest) -> Result<i32, AppError> {
    get_user_id_from_request(req).ok_or(AppError::Unauthorized)
}

/// Wraps `wayve_security::rbac::require_permission` so the error is
/// `AppError::Forbidden` (or `Unauthorized`) instead of a ready-rendered
/// `HttpResponse`. Lets the caller use `?` and lets `AppError`'s
/// `ResponseError` impl produce a consistent error envelope.
///
/// On the rare 5xx path (rbac role resolution failing because the DB is down,
/// for example), the underlying call already logs the cause and returns
/// `InternalServerError().finish()`; that body is opaque to the client either
/// way, so collapsing it to `AppError::Internal` here doesn't lose info.
#[allow(dead_code)]
pub async fn require_permission_app(
    req: &HttpRequest,
    pool: &PgPool,
    perm: Permission,
) -> Result<RoleContext, AppError> {
    require_permission(req, pool, perm)
        .await
        .map_err(|resp| match resp.status().as_u16() {
            401 => AppError::Unauthorized,
            403 => AppError::Forbidden,
            _ => AppError::internal("rbac check failed"),
        })
}
