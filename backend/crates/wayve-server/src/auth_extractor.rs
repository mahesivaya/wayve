//! Auth chokepoints adapted to the `AppError` flow.
//!
//! The primitives in `wayve_security` (`jwt::get_user_id_from_request`,
//! `rbac::require_permission`) return `Result<…, HttpResponse>`, which forces
//! every handler to peel the `Err` branch by hand. These wrappers convert that to
//! `Result<…, AppError>` so `?` works. Existing handlers are unchanged; use these
//! in new ones.

use crate::error::AppError;
use actix_web::HttpRequest;
use sqlx::PgPool;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Permission, RoleContext, require_permission};

/// Pull a verified user id out of the request, or 401.
#[allow(dead_code)]
pub fn require_user(req: &HttpRequest) -> Result<i32, AppError> {
    get_user_id_from_request(req).ok_or(AppError::Unauthorized)
}

/// Wrap `wayve_security::rbac::require_permission` so the error is an `AppError`
/// rather than a rendered `HttpResponse`, giving callers `?` and a consistent
/// error envelope. Collapsing the rare 5xx path to `AppError::Internal` loses
/// nothing: the underlying call already logged the cause and its body was opaque.
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
