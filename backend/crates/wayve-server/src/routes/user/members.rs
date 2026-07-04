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

// ──────────────────────────────────────────────────────────────────────
// Member detail (scoped to the caller's own team)
// ──────────────────────────────────────────────────────────────────────

/// Load the full profile + per-service storage breakdown for one user, the
/// data behind the scoped member detail page. Returns `None` when the user id
/// doesn't exist. Callers MUST authorize membership first (own org / platform
/// team) — this helper does no access control of its own. Runs with the RLS
/// bypass GUC because it sums storage across RLS-enabled tables (emails, drive,
/// chat, notes, tasks) for an arbitrary user.
async fn load_member_detail(
    pool: &PgPool,
    user_id: i32,
) -> std::result::Result<Option<serde_json::Value>, crate::error::AppError> {
    let mut tx = pool.begin().await?;
    crate::db::apply_rls_bypass(&mut tx).await?;

    let user = sqlx::query(
        r#"
        SELECT
            u.id, u.email, u.first_name, u.last_name, u.username, u.avatar_path,
            u.auth_provider, u.account_type, u.created_at, u.email_verified,
            u.organization_id,
            o.name  AS organization_name,
            pm.role AS platform_role,
            om.role AS organization_role
        FROM users u
        LEFT JOIN organizations o     ON o.id = u.organization_id
        LEFT JOIN platform_members pm ON pm.user_id = u.id
        LEFT JOIN organization_members om
               ON om.user_id = u.id AND om.organization_id = u.organization_id
        WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = user else {
        tx.commit().await?;
        return Ok(None);
    };

    let storage = sqlx::query(
        r#"
        SELECT
            (SELECT COALESCE(SUM(octet_length(e.body_encrypted)), 0)::BIGINT FROM emails e
               JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = $1) AS gmail_bytes,
            (SELECT COALESCE(SUM(f.size), 0)::BIGINT FROM drive_files f WHERE f.user_id = $1) AS drive_bytes,
            (SELECT COALESCE(SUM(octet_length(m.content_encrypted)), 0)::BIGINT FROM messages m WHERE m.sender_id = $1) AS chat_bytes,
            (SELECT COALESCE(SUM(octet_length(coalesce(n.content_encrypted, n.content, ''))), 0)::BIGINT FROM notes n WHERE n.user_id = $1) AS notes_bytes,
            (SELECT COALESCE(SUM(octet_length(t.name) + octet_length(coalesce(t.description, ''))), 0)::BIGINT FROM tasks t WHERE t.user_id = $1) AS tasks_bytes
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let gmail = storage.try_get::<i64, _>("gmail_bytes").unwrap_or(0);
    let drive = storage.try_get::<i64, _>("drive_bytes").unwrap_or(0);
    let chat = storage.try_get::<i64, _>("chat_bytes").unwrap_or(0);
    let notes = storage.try_get::<i64, _>("notes_bytes").unwrap_or(0);
    let tasks = storage.try_get::<i64, _>("tasks_bytes").unwrap_or(0);
    let created_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("created_at").ok();

    Ok(Some(serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or(0),
        "email": row.try_get::<String, _>("email").unwrap_or_default(),
        "first_name": row.try_get::<Option<String>, _>("first_name").ok().flatten(),
        "last_name": row.try_get::<Option<String>, _>("last_name").ok().flatten(),
        "username": row.try_get::<Option<String>, _>("username").ok().flatten(),
        "avatar_path": row.try_get::<Option<String>, _>("avatar_path").ok().flatten(),
        "auth_provider": row.try_get::<Option<String>, _>("auth_provider").ok().flatten(),
        "account_type": row.try_get::<Option<String>, _>("account_type").ok().flatten(),
        "email_verified": row.try_get::<Option<bool>, _>("email_verified").ok().flatten().unwrap_or(false),
        "created_at": created_at,
        "organization_id": row.try_get::<Option<i32>, _>("organization_id").ok().flatten(),
        "organization_name": row.try_get::<Option<String>, _>("organization_name").ok().flatten(),
        "platform_role": row.try_get::<Option<String>, _>("platform_role").ok().flatten(),
        "organization_role": row.try_get::<Option<String>, _>("organization_role").ok().flatten(),
        "storage": {
            "total_bytes": gmail + drive + chat + notes + tasks,
            "gmail_bytes": gmail,
            "drive_bytes": drive,
            "chat_bytes": chat,
            "notes_bytes": notes,
            "tasks_bytes": tasks,
        },
    })))
}

/// Detail for one member of an organization. Gated by `require_org_access`, so
/// an org/enterprise admin only ever resolves members of THEIR OWN org — the
/// target must also belong to `{id}` (otherwise 404), never a user from
/// another org or an unrelated personal account.
#[get("/organizations/{id}/members/{user_id}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn organization_member_detail(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, user_id) = path.into_inner();
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

    // The target must be a member of THIS org. Guard before loading so an admin
    // can't read a user from another org by guessing an id.
    let belongs: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND organization_id = $2)",
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_one(pool.get_ref())
    .await?;
    if !belongs {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Member not found in this organization" })));
    }

    match load_member_detail(pool.get_ref(), user_id).await? {
        Some(detail) => Ok(HttpResponse::Ok().json(detail)),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Member not found" })))
        }
    }
}

/// Detail for one member of the platform team. Gated to `Scope::Platform`; the
/// target must be a `platform_members` row (the platform staff roster), so this
/// never exposes arbitrary personal users — only the caller's own team.
#[get("/platform/members/{user_id}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn platform_member_detail(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform {
        return Ok(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform staff access required" })));
    }
    let user_id = path.into_inner();

    let is_staff: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_members WHERE user_id = $1)")
            .bind(user_id)
            .fetch_one(pool.get_ref())
            .await?;
    if !is_staff {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Platform team member not found" })));
    }

    match load_member_detail(pool.get_ref(), user_id).await? {
        Some(detail) => Ok(HttpResponse::Ok().json(detail)),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Member not found" })))
        }
    }
}
