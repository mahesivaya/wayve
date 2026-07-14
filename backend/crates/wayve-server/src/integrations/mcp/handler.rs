//! MCP connection management, restricted to platform owners and admins and to
//! enterprise-tier organization owners and admins: the `mcp:manage` permission
//! plus a scope and tier gate. Rejecting personal and business accounts is what
//! keeps the AI from reading data on those tiers. Auth tokens are encrypted at
//! rest.

use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Permission, Scope, resolve_role_context, resolve_role_context_moded};

use super::client::McpClient;
use super::models::{ConnectInput, ConnectionStatus, McpConnection, McpOwner, UpdateInput};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(list_connections)
        .service(create_connection)
        .service(update_connection)
        .service(delete_connection);
}

/// Resolve an MCP owner from an already-resolved role context, or `Forbidden`.
/// Requires `mcp:manage` plus either platform scope or an enterprise-tier org: a
/// personal owner holds every permission in their own scope, so the scope and
/// tier match, not the permission check, is the real gate. Taking the context as
/// an argument lets the management endpoints pass a mode-downscoped one while the
/// AI loop passes DB truth.
async fn mcp_owner_for_ctx(
    pool: &PgPool,
    ctx: &wayve_security::rbac::RoleContext,
) -> Result<McpOwner, AppError> {
    if !ctx.has(Permission::McpManage) {
        return Err(AppError::Forbidden);
    }
    match ctx.scope {
        Scope::Platform => Ok(McpOwner::Platform),
        Scope::Organization => {
            let org_id = ctx.organization_id.ok_or(AppError::Forbidden)?;
            if is_enterprise_org(pool, org_id).await? {
                Ok(McpOwner::Organization(org_id))
            } else {
                Err(AppError::Forbidden)
            }
        }
        Scope::Personal => Err(AppError::Forbidden),
    }
}

/// Owner gate for the interactive management endpoints. Mode-aware, so a
/// normal-mode owner is refused and must switch to admin mode.
async fn require_mcp_owner(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<McpOwner, AppError> {
    let ctx = resolve_role_context_moded(req, pool, user_id)
        .await
        .map_err(AppError::from)?;
    mcp_owner_for_ctx(pool, &ctx).await
}

/// Best-effort owner resolution for the AI loop: a non-owner gets `None` and no
/// tools rather than an error, so basic chat still works. Uses the DB-truth role
/// rather than the downscoped one, since using your own configured tools inside
/// AI chat is not an admin action.
pub(crate) async fn resolve_mcp_owner_opt(pool: &PgPool, user_id: i32) -> Option<McpOwner> {
    let ctx = resolve_role_context(pool, user_id).await.ok()?;
    mcp_owner_for_ctx(pool, &ctx).await.ok()
}

async fn is_enterprise_org(pool: &PgPool, org_id: i32) -> Result<bool, AppError> {
    let enterprise: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.organization_id = $1 AND s.status = 'active' AND p.tier = 'enterprise'
        )",
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    Ok(enterprise)
}

/// Load and decrypt an owner's connections. The AI loop passes `enabled_only`;
/// the management list passes `false`.
pub(crate) async fn load_connections(
    pool: &PgPool,
    owner: McpOwner,
    enabled_only: bool,
) -> Result<Vec<McpConnection>, AppError> {
    let (scope, org_id) = owner.as_columns();
    let sql = if enabled_only {
        "SELECT label, server_url, auth_token_iv, auth_token_encrypted
           FROM mcp_connections
          WHERE owner_scope = $1 AND organization_id IS NOT DISTINCT FROM $2 AND enabled
          ORDER BY id"
    } else {
        "SELECT label, server_url, auth_token_iv, auth_token_encrypted
           FROM mcp_connections
          WHERE owner_scope = $1 AND organization_id IS NOT DISTINCT FROM $2
          ORDER BY id"
    };
    let rows = sqlx::query(sql)
        .bind(scope)
        .bind(org_id)
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let iv: Option<String> = row.try_get("auth_token_iv").ok().flatten();
        let enc: Option<String> = row.try_get("auth_token_encrypted").ok().flatten();
        let auth_token = match (iv, enc) {
            (Some(iv), Some(enc)) => Some(decrypt(&iv, &enc).map_err(|e| {
                warn!(target: "worker", error = %e, "mcp token decrypt failed");
                AppError::Internal("Failed to read MCP credentials".into())
            })?),
            _ => None,
        };
        out.push(McpConnection {
            label: row.get("label"),
            server_url: row.get("server_url"),
            auth_token,
        });
    }
    Ok(out)
}

/// Run the validating handshake against a server. A connection or auth failure
/// surfaces as a 400 or 401 so the admin can fix it.
async fn validate_server(
    server_url: &str,
    token: Option<&str>,
) -> Result<(Option<String>, i32), AppError> {
    let client = McpClient::new(server_url, token);
    let server_name = client.initialize().await?;
    let tools = client.list_tools().await?;
    Ok((server_name, tools.len() as i32))
}

#[get("/integrations/mcp/connections")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_connections(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_mcp_owner(&req, pool.get_ref(), user_id).await?;
    let (scope, org_id) = owner.as_columns();
    let rows = sqlx::query(
        "SELECT id, label, server_url, enabled, server_name, last_tool_count, last_validated_at
           FROM mcp_connections
          WHERE owner_scope = $1 AND organization_id IS NOT DISTINCT FROM $2
          ORDER BY id",
    )
    .bind(scope)
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await?;
    let out: Vec<ConnectionStatus> = rows
        .iter()
        .map(|r| ConnectionStatus {
            id: r.get("id"),
            label: r.get("label"),
            server_url: r.get("server_url"),
            enabled: r.get("enabled"),
            server_name: r.try_get::<Option<String>, _>("server_name").ok().flatten(),
            last_tool_count: r
                .try_get::<Option<i32>, _>("last_tool_count")
                .ok()
                .flatten(),
            last_validated_at: r
                .try_get::<Option<NaiveDateTime>, _>("last_validated_at")
                .ok()
                .flatten(),
        })
        .collect();
    Ok(HttpResponse::Ok().json(out))
}

#[post("/integrations/mcp/connections")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_connection(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ConnectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_mcp_owner(&req, pool.get_ref(), user_id).await?;

    let label = body.label.trim().to_string();
    let server_url = body.server_url.trim().to_string();
    if label.is_empty() {
        return Err(AppError::bad_request("label is required"));
    }
    if server_url.is_empty() {
        return Err(AppError::bad_request("server_url is required"));
    }

    let no_auth = body.auth_type.as_deref() == Some("none");
    let token = body
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (auth_type, token) = if no_auth {
        ("none", None)
    } else {
        ("bearer", token)
    };

    // The handshake validates before storing, and is SSRF-checked in the client.
    let (server_name, tool_count) = validate_server(&server_url, token).await?;

    let (iv, enc) = match token {
        Some(t) => {
            let (iv, c) = encrypt(t).map_err(|e| {
                warn!(target: "worker", error = %e, "mcp token encrypt failed");
                AppError::Internal("Failed to store MCP credentials".into())
            })?;
            (Some(iv), Some(c))
        }
        None => (None, None),
    };

    let (scope, org_id) = owner.as_columns();
    let row = sqlx::query(
        "INSERT INTO mcp_connections
            (owner_scope, organization_id, label, server_url, auth_type,
             auth_token_iv, auth_token_encrypted, server_name, last_tool_count,
             last_validated_at, connected_by, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, TRUE, NOW())
         RETURNING id, last_validated_at",
    )
    .bind(scope)
    .bind(org_id)
    .bind(&label)
    .bind(&server_url)
    .bind(auth_type)
    .bind(&iv)
    .bind(&enc)
    .bind(&server_name)
    .bind(tool_count)
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db) = &e
            && db.code().as_deref() == Some("23505")
        {
            return AppError::bad_request("A server with this URL is already connected");
        }
        AppError::from(e)
    })?;

    info!(target: "worker", user_id, scope, tool_count, "mcp connection created");
    Ok(HttpResponse::Ok().json(ConnectionStatus {
        id: row.get("id"),
        label,
        server_url,
        enabled: true,
        server_name,
        last_tool_count: Some(tool_count),
        last_validated_at: row
            .try_get::<Option<NaiveDateTime>, _>("last_validated_at")
            .ok()
            .flatten(),
    }))
}

#[put("/integrations/mcp/connections/{id}")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn update_connection(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<UpdateInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_mcp_owner(&req, pool.get_ref(), user_id).await?;
    let id = path.into_inner();
    let (scope, org_id) = owner.as_columns();

    // Scoping the load to the owner means another owner's row 404s.
    let existing = sqlx::query(
        "SELECT label, server_url, auth_type, auth_token_iv, auth_token_encrypted, enabled
           FROM mcp_connections
          WHERE id = $1 AND owner_scope = $2 AND organization_id IS NOT DISTINCT FROM $3",
    )
    .bind(id)
    .bind(scope)
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("MCP connection"))?;

    let cur_url: String = existing.get("server_url");
    let cur_iv: Option<String> = existing.try_get("auth_token_iv").ok().flatten();
    let cur_enc: Option<String> = existing.try_get("auth_token_encrypted").ok().flatten();
    let cur_auth_type: String = existing.get("auth_type");

    let new_label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let new_url = body
        .server_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let enabled = body.enabled;

    // An omitted auth_token keeps the current one; an empty string clears it and
    // drops auth_type to none; anything else replaces it.
    let url_changed = new_url.as_ref().is_some_and(|u| u != &cur_url);
    let token_field = body.auth_token.as_deref();
    let token_changed = token_field.is_some();
    let effective_url = new_url.clone().unwrap_or_else(|| cur_url.clone());

    let effective_token: Option<String> = match token_field {
        Some(t) if t.trim().is_empty() => None,
        Some(t) => Some(t.trim().to_string()),
        None => match (&cur_iv, &cur_enc) {
            (Some(iv), Some(enc)) => Some(decrypt(iv, enc).map_err(|e| {
                warn!(target: "worker", error = %e, "mcp token decrypt failed");
                AppError::Internal("Failed to read MCP credentials".into())
            })?),
            _ => None,
        },
    };

    let mut server_name: Option<String> = None;
    let mut tool_count: Option<i32> = None;
    let revalidate = url_changed || token_changed;
    if revalidate {
        let (name, count) = validate_server(&effective_url, effective_token.as_deref()).await?;
        server_name = name;
        tool_count = Some(count);
    }

    let (set_token, new_iv, new_enc, new_auth_type): (
        bool,
        Option<String>,
        Option<String>,
        String,
    ) = if let Some(t) = token_field {
        if t.trim().is_empty() {
            (true, None, None, "none".to_string())
        } else {
            let (iv, c) = encrypt(t.trim()).map_err(|e| {
                warn!(target: "worker", error = %e, "mcp token encrypt failed");
                AppError::Internal("Failed to store MCP credentials".into())
            })?;
            (true, Some(iv), Some(c), "bearer".to_string())
        }
    } else {
        (
            false,
            cur_iv.clone(),
            cur_enc.clone(),
            cur_auth_type.clone(),
        )
    };

    sqlx::query(
        "UPDATE mcp_connections SET
            label = COALESCE($4, label),
            server_url = COALESCE($5, server_url),
            enabled = COALESCE($6, enabled),
            auth_type = CASE WHEN $7 THEN $8 ELSE auth_type END,
            auth_token_iv = CASE WHEN $7 THEN $9 ELSE auth_token_iv END,
            auth_token_encrypted = CASE WHEN $7 THEN $10 ELSE auth_token_encrypted END,
            server_name = CASE WHEN $11 THEN $12 ELSE server_name END,
            last_tool_count = CASE WHEN $11 THEN $13 ELSE last_tool_count END,
            last_validated_at = CASE WHEN $11 THEN NOW() ELSE last_validated_at END,
            updated_at = NOW()
         WHERE id = $1 AND owner_scope = $2 AND organization_id IS NOT DISTINCT FROM $3",
    )
    .bind(id)
    .bind(scope)
    .bind(org_id)
    .bind(&new_label)
    .bind(&new_url)
    .bind(enabled)
    .bind(set_token)
    .bind(&new_auth_type)
    .bind(&new_iv)
    .bind(&new_enc)
    .bind(revalidate)
    .bind(&server_name)
    .bind(tool_count)
    .execute(pool.get_ref())
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db) = &e
            && db.code().as_deref() == Some("23505")
        {
            return AppError::bad_request("A server with this URL is already connected");
        }
        AppError::from(e)
    })?;

    info!(target: "worker", user_id, id, revalidate, "mcp connection updated");

    let row = sqlx::query(
        "SELECT id, label, server_url, enabled, server_name, last_tool_count, last_validated_at
           FROM mcp_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(ConnectionStatus {
        id: row.get("id"),
        label: row.get("label"),
        server_url: row.get("server_url"),
        enabled: row.get("enabled"),
        server_name: row
            .try_get::<Option<String>, _>("server_name")
            .ok()
            .flatten(),
        last_tool_count: row
            .try_get::<Option<i32>, _>("last_tool_count")
            .ok()
            .flatten(),
        last_validated_at: row
            .try_get::<Option<NaiveDateTime>, _>("last_validated_at")
            .ok()
            .flatten(),
    }))
}

#[delete("/integrations/mcp/connections/{id}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn delete_connection(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_mcp_owner(&req, pool.get_ref(), user_id).await?;
    let id = path.into_inner();
    let (scope, org_id) = owner.as_columns();
    let result = sqlx::query(
        "DELETE FROM mcp_connections
          WHERE id = $1 AND owner_scope = $2 AND organization_id IS NOT DISTINCT FROM $3",
    )
    .bind(id)
    .bind(scope)
    .bind(org_id)
    .execute(pool.get_ref())
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("MCP connection"));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
