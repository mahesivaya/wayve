//! Per-scope feature access control (organization + platform).
//!
//! The RBAC role→permission matrix in `wayve-security` is fixed at compile
//! time. This module layers a per-scope override on top of it for a small,
//! explicit catalog of user-facing features (currently the Code Repo viewer and
//! Billing): the OWNER of a scope decides which roles in that scope may use each
//! feature. Organizations are keyed by `organization_id`; the platform is a
//! singleton scope with no id.
//!
//! Storage model (`organization_feature_access` / `platform_feature_access`):
//! one row = "this role may use this feature in this scope". If a feature has
//! ANY rows for the scope it is considered *configured* and only the listed
//! roles are allowed; with no rows it falls back to the feature's
//! [`Feature::default_roles`]. The owner is always allowed (and force-included
//! on save) so an owner can never lock themselves out.

use crate::prelude::*;
use actix_web::put;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Scope};

/// A gateable feature. `default_roles` mirrors the feature's pre-existing
/// access so enabling this system changes nothing until an owner edits it.
pub struct Feature {
    pub key: &'static str,
    pub label: &'static str,
    pub default_roles: &'static [&'static str],
}

/// The full set of org roles, in display order — the columns of the matrix.
pub const ALL_ROLES: &[&str] = &[
    "owner",
    "super_admin",
    "admin",
    "security",
    "billing",
    "developer",
    "support",
    "member",
    "guest",
];

/// The catalog of controllable features. Add entries here (plus an enforcement
/// check at the feature's API) to gate more.
pub const FEATURES: &[Feature] = &[
    Feature {
        key: "code_repo",
        // Inherits the Code Repo sidebar default: org managers + developers.
        label: "Code Repo",
        default_roles: &["owner", "super_admin", "admin", "developer"],
    },
    Feature {
        key: "billing",
        // Billing has always been owner + billing-role only (super_admin is
        // explicitly excluded). Keeps developers and other roles out by default.
        label: "Billing",
        default_roles: &["owner", "billing"],
    },
];

fn feature(key: &str) -> Option<&'static Feature> {
    FEATURES.iter().find(|f| f.key == key)
}

/// Roles allowed to use `feature_key` in `org_id`: the configured set if the
/// owner has saved one, otherwise the feature's default. Returns an empty vec
/// for an unknown feature key.
pub async fn allowed_roles(
    pool: &PgPool,
    org_id: i32,
    feature_key: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT role FROM organization_feature_access \
         WHERE organization_id = $1 AND feature_key = $2",
    )
    .bind(org_id)
    .bind(feature_key)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        let def = feature(feature_key).map(|f| f.default_roles).unwrap_or(&[]);
        Ok(def.iter().map(|s| s.to_string()).collect())
    } else {
        Ok(rows)
    }
}

/// Whether `role` may use `feature_key` in `org_id`. The owner is always
/// allowed regardless of configuration.
pub async fn is_allowed(
    pool: &PgPool,
    org_id: i32,
    feature_key: &str,
    role: &str,
) -> Result<bool, sqlx::Error> {
    if role == "owner" {
        return Ok(true);
    }
    let allowed = allowed_roles(pool, org_id, feature_key).await?;
    Ok(allowed.iter().any(|r| r == role))
}

/// Platform counterpart of [`allowed_roles`]: the configured set if the platform
/// owner has saved one, otherwise the feature's default.
pub async fn allowed_roles_platform(
    pool: &PgPool,
    feature_key: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT role FROM platform_feature_access WHERE feature_key = $1")
            .bind(feature_key)
            .fetch_all(pool)
            .await?;

    if rows.is_empty() {
        let def = feature(feature_key).map(|f| f.default_roles).unwrap_or(&[]);
        Ok(def.iter().map(|s| s.to_string()).collect())
    } else {
        Ok(rows)
    }
}

/// Platform counterpart of [`is_allowed`]. The platform owner is always allowed.
pub async fn is_allowed_platform(
    pool: &PgPool,
    feature_key: &str,
    role: &str,
) -> Result<bool, sqlx::Error> {
    if role == "owner" {
        return Ok(true);
    }
    let allowed = allowed_roles_platform(pool, feature_key).await?;
    Ok(allowed.iter().any(|r| r == role))
}

/// Guard for the top of a feature's handlers: ensure the caller's role may use
/// `feature_key`. Organization callers are checked against the per-org matrix
/// and platform callers against the platform matrix; personal callers pass
/// through unaffected (their access is governed by RBAC alone). Returns a
/// ready-to-send 401/403/500 on failure.
pub async fn require_feature(
    req: &HttpRequest,
    pool: &PgPool,
    feature_key: &str,
) -> Result<(), HttpResponse> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(HttpResponse::Unauthorized().finish());
    };
    let ctx = rbac::resolve_role_context(pool, user_id)
        .await
        .map_err(|_| HttpResponse::InternalServerError().finish())?;
    let allowed = match ctx.scope {
        Scope::Personal => return Ok(()),
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(());
            };
            is_allowed(pool, org_id, feature_key, ctx.role.as_str()).await
        }
        Scope::Platform => is_allowed_platform(pool, feature_key, ctx.role.as_str()).await,
    };
    match allowed {
        Ok(true) => Ok(()),
        Ok(false) => {
            let label = feature(feature_key).map(|f| f.label).unwrap_or(feature_key);
            Err(HttpResponse::Forbidden().json(serde_json::json!({
                "message": format!("Your role doesn't have access to {label}")
            })))
        }
        Err(_) => Err(HttpResponse::InternalServerError().finish()),
    }
}

/// GET /api/feature-access — the full matrix for the caller's scope
/// (organization or platform). Any member of that scope may read it (the client
/// uses it to gate nav); only the owner may change it (see
/// `update_feature_access`).
#[get("/feature-access")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_feature_access(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(AppError::Db)?;

    let mut features = Vec::with_capacity(FEATURES.len());
    match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            };
            for f in FEATURES {
                let allowed = allowed_roles(pool.get_ref(), org_id, f.key).await?;
                features.push(serde_json::json!({
                    "key": f.key,
                    "label": f.label,
                    "allowed_roles": allowed,
                    "default_roles": f.default_roles,
                }));
            }
        }
        Scope::Platform => {
            for f in FEATURES {
                let allowed = allowed_roles_platform(pool.get_ref(), f.key).await?;
                features.push(serde_json::json!({
                    "key": f.key,
                    "label": f.label,
                    "allowed_roles": allowed,
                    "default_roles": f.default_roles,
                }));
            }
        }
        Scope::Personal => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Feature access is managed per organization or platform"
            })));
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "roles": ALL_ROLES,
        "features": features,
    })))
}

#[derive(Deserialize)]
pub struct UpdateFeatureAccessInput {
    pub roles: Vec<String>,
}

/// PUT /api/feature-access/{key} — replace the allowed-role set for one
/// feature in the caller's scope (organization or platform). Owner-only.
/// `owner` is always force-included so the owner can't be locked out; unknown
/// role names are ignored.
#[put("/feature-access/{key}")]
#[instrument(target = "http", skip(req, pool, path, input))]
pub async fn update_feature_access(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
    input: web::Json<UpdateFeatureAccessInput>,
) -> AppResult {
    // Accepts both organization and platform owners (personal is rejected).
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let key = path.into_inner();
    let Some(f) = feature(&key) else {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Unknown feature" }))
        );
    };

    // Keep only valid role names, de-dup, and guarantee the owner is present.
    let mut roles: Vec<String> = Vec::new();
    for r in input.roles.iter() {
        if ALL_ROLES.contains(&r.as_str()) && !roles.contains(r) {
            roles.push(r.clone());
        }
    }
    if !roles.iter().any(|r| r == "owner") {
        roles.push("owner".to_string());
    }

    match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "No organization in context" })));
            };
            let mut tx = pool.begin().await?;
            sqlx::query(
                "DELETE FROM organization_feature_access \
                 WHERE organization_id = $1 AND feature_key = $2",
            )
            .bind(org_id)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
            for role in &roles {
                sqlx::query(
                    "INSERT INTO organization_feature_access (organization_id, feature_key, role) \
                     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                )
                .bind(org_id)
                .bind(&key)
                .bind(role)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
        }
        Scope::Platform => {
            let mut tx = pool.begin().await?;
            sqlx::query("DELETE FROM platform_feature_access WHERE feature_key = $1")
                .bind(&key)
                .execute(&mut *tx)
                .await?;
            for role in &roles {
                sqlx::query(
                    "INSERT INTO platform_feature_access (feature_key, role) \
                     VALUES ($1, $2) ON CONFLICT DO NOTHING",
                )
                .bind(&key)
                .bind(role)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
        }
        Scope::Personal => {
            // require_owner already rejects personal scope; keep exhaustive.
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Feature access is managed per organization or platform"
            })));
        }
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "key": f.key,
        "label": f.label,
        "allowed_roles": roles,
        "default_roles": f.default_roles,
    })))
}
