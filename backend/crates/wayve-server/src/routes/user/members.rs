//! RBAC member listing & role management:
//! `/organizations/{id}/members`, `/platform/members`, and the role-change
//! endpoints for each scope.

use super::shared::{
    invalidate_profile_cache, normalized_org_role, normalized_platform_role, role_label,
};
use crate::audit::{self, AuditEvent};
use crate::email::profile::invalidate_me_cache;
use crate::prelude::*;
use actix_web::put;
use tracing::{info, instrument};
use wayve_security::rbac::{self, Permission, Role, Scope};

/// Body of a role-change request.
#[derive(Deserialize)]
pub struct UpdateRoleInput {
    pub role: String,
}

/// Parse a request's target role, rejecting anything that is not an exact
/// canonical role token (so "Owner", "MEMBER", "bogus" are 400s rather than
/// silently normalizing to `member`).
fn parse_assignable_role(raw: &str) -> Option<Role> {
    let trimmed = raw.trim();
    let role = Role::from_str(trimmed);
    (role.as_str() == trimmed).then_some(role)
}

/// JSON for one member row of a `/members` listing.
fn member_row_json(row: &sqlx::postgres::PgRow, platform: bool) -> serde_json::Value {
    let user_id: i32 = row.get("user_id");
    let email: String = row.get("email");
    let username: Option<String> = row.try_get("username").ok().flatten();
    let stored_role: String = row.get("role");
    let role = if platform {
        normalized_platform_role(&stored_role)
    } else {
        normalized_org_role(&stored_role)
    };
    let account_type = if platform {
        "platform_admin"
    } else {
        "organization"
    };
    serde_json::json!({
        "user_id": user_id,
        "email": email,
        "username": username,
        "role": role,
        "role_label": role_label(role, account_type),
    })
}

#[get("/organizations/{id}/members")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_organization_members(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let organization_id = path.into_inner();
    if let Err(response) = rbac::require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::MembersRead,
    )
    .await
    {
        return Ok(response);
    }

    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.email, u.username,
               COALESCE(om.role, 'member') AS role
        FROM users u
        LEFT JOIN organization_members om
          ON om.organization_id = u.organization_id AND om.user_id = u.id
        WHERE u.organization_id = $1
        ORDER BY u.email
        "#,
    )
    .bind(organization_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(
        rows.iter()
            .map(|row| member_row_json(row, false))
            .collect::<Vec<_>>(),
    ))
}

#[put("/organizations/{id}/members/{user_id}/role")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn update_organization_member_role(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
    data: web::Json<UpdateRoleInput>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();

    let ctx = match rbac::require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::RolesAssignLimited,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let Some(new_role) = parse_assignable_role(&data.role) else {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Unknown role" }))
        );
    };

    let mut tx = pool.begin().await?;

    // Confirm the target belongs to this organization and read their role.
    let current = match sqlx::query(
        r#"
        SELECT u.organization_id, COALESCE(om.role, 'member') AS role
        FROM users u
        LEFT JOIN organization_members om
          ON om.organization_id = $1 AND om.user_id = u.id
        WHERE u.id = $2
        "#,
    )
    .bind(organization_id)
    .bind(target_user_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(row) => row,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
            );
        }
    };

    let target_org: Option<i32> = current.try_get("organization_id").ok().flatten();
    if target_org != Some(organization_id) {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "User is not a member of this organization" })));
    }
    let current_role = Role::from_str(&current.get::<String, _>("role"));

    if !rbac::can_assign_role(&ctx, current_role, new_role) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Your role cannot assign or modify that role"
        })));
    }

    // Never strand an organization with zero owners. `FOR UPDATE` locks the
    // owner rows so two concurrent demotions can't both pass this check.
    if current_role == Role::Owner && new_role != Role::Owner {
        let owners = sqlx::query_scalar::<_, i32>(
            "SELECT user_id FROM organization_members \
             WHERE organization_id = $1 AND role = 'owner' FOR UPDATE",
        )
        .bind(organization_id)
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Cannot demote the last owner of the organization"
            })));
        }
    }

    sqlx::query(
        r#"
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, user_id) DO UPDATE
        SET role = EXCLUDED.role, updated_at = NOW()
        "#,
    )
    .bind(organization_id)
    .bind(target_user_id)
    .bind(new_role.as_str())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Refresh the target's cached identity so the new permissions take effect
    // on their next request rather than after the 60s cache TTL.
    invalidate_me_cache(target_user_id).await;
    invalidate_profile_cache(target_user_id).await;
    rbac::invalidate_role_context(target_user_id).await;
    info!(
        target: "auth",
        actor = ctx.user_id, organization_id, target_user_id,
        role = new_role.as_str(),
        "organization member role updated"
    );

    // Audit the privilege change (Tier-1: escalation/lateral movement). Skip
    // the no-op case where the role didn't actually change. Best-effort.
    if current_role != new_role {
        audit::record_action(
            pool.get_ref(),
            &req,
            AuditEvent {
                actor_user_id: ctx.user_id,
                action: "role_change",
                resource_type: "organization_member",
                resource_id: Some(target_user_id.to_string()),
                metadata: Some(serde_json::json!({
                    "scope": "organization",
                    "organization_id": organization_id,
                    "target_user_id": target_user_id,
                    "from_role": current_role.as_str(),
                    "to_role": new_role.as_str(),
                })),
            },
        )
        .await;
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user_id": target_user_id,
        "role": new_role.as_str(),
        "role_label": role_label(new_role.as_str(), "organization"),
    })))
}

#[get("/platform/members")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_platform_members(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform {
        return Ok(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform staff access required" })));
    }

    let rows = sqlx::query(
        r#"
        SELECT u.id AS user_id, u.email, u.username, pm.role AS role
        FROM platform_members pm
        JOIN users u ON u.id = pm.user_id
        ORDER BY u.email
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(
        rows.iter()
            .map(|row| member_row_json(row, true))
            .collect::<Vec<_>>(),
    ))
}

#[put("/platform/members/{user_id}/role")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn update_platform_member_role(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<UpdateRoleInput>,
) -> AppResult {
    let target_user_id = path.into_inner();

    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::RolesAssignLimited)
        .await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform {
        return Ok(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform staff access required" })));
    }

    let Some(new_role) = parse_assignable_role(&data.role) else {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Unknown role" }))
        );
    };

    let mut tx = pool.begin().await?;

    let current_role = match sqlx::query_scalar::<_, String>(
        "SELECT role FROM platform_members WHERE user_id = $1",
    )
    .bind(target_user_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(role) => Role::from_str(&role),
        None => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "User is not a platform member" })));
        }
    };

    if !rbac::can_assign_role(&ctx, current_role, new_role) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Your role cannot assign or modify that role"
        })));
    }

    if current_role == Role::Owner && new_role != Role::Owner {
        let owners = sqlx::query_scalar::<_, i32>(
            "SELECT user_id FROM platform_members WHERE role = 'owner' FOR UPDATE",
        )
        .fetch_all(&mut *tx)
        .await?;
        if owners.len() <= 1 {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Cannot demote the last platform owner"
            })));
        }
    }

    sqlx::query("UPDATE platform_members SET role = $1, updated_at = NOW() WHERE user_id = $2")
        .bind(new_role.as_str())
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    invalidate_me_cache(target_user_id).await;
    invalidate_profile_cache(target_user_id).await;
    rbac::invalidate_role_context(target_user_id).await;
    info!(
        target: "auth",
        actor = ctx.user_id, target_user_id,
        role = new_role.as_str(),
        "platform member role updated"
    );

    // Audit the privilege change (Tier-1: escalation/lateral movement). Skip
    // the no-op case where the role didn't actually change. Best-effort.
    if current_role != new_role {
        audit::record_action(
            pool.get_ref(),
            &req,
            AuditEvent {
                actor_user_id: ctx.user_id,
                action: "role_change",
                resource_type: "platform_member",
                resource_id: Some(target_user_id.to_string()),
                metadata: Some(serde_json::json!({
                    "scope": "platform",
                    "target_user_id": target_user_id,
                    "from_role": current_role.as_str(),
                    "to_role": new_role.as_str(),
                })),
            },
        )
        .await;
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user_id": target_user_id,
        "role": new_role.as_str(),
        "role_label": role_label(new_role.as_str(), "platform_admin"),
    })))
}
