// Dashboard endpoints for managing SCIM tokens. Unlike the SCIM surface
// itself, these authenticate with the standard JWT and are gated on
// `webhooks:manage`, the sibling permission for managing IdP integrations.

use super::tokens::{generate, sha256_hex};
use crate::prelude::*;
use actix_web::delete;
use sqlx::Row;
use tracing::instrument;
use wayve_security::rbac::{self, Permission};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(list_scim_tokens)
        .service(create_scim_token)
        .service(revoke_scim_token);
}

#[derive(Deserialize)]
pub struct CreateScimTokenInput {
    pub name: String,
    pub organization_id: i32,
}

#[get("/scim/tokens")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_scim_tokens(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    let rows = sqlx::query(
        r#"
        SELECT t.id, t.organization_id, o.name AS organization_name, t.name,
               t.token_preview, t.last_used_at, t.revoked_at, t.created_at
          FROM scim_tokens t
          LEFT JOIN organizations o ON o.id = t.organization_id
         WHERE ($1::INTEGER IS NULL OR t.organization_id = $1)
         ORDER BY t.id DESC
        "#,
    )
    // Platform-scope sees all orgs; org-scope is restricted to their own org.
    .bind(if ctx.scope == rbac::Scope::Platform {
        None::<i32>
    } else {
        ctx.organization_id
    })
    .fetch_all(pool.get_ref())
    .await?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "organization_id": row.try_get::<i32, _>("organization_id").unwrap_or(0),
                "organization_name": row.try_get::<Option<String>, _>("organization_name").ok().flatten(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "token_preview": row.try_get::<String, _>("token_preview").unwrap_or_default(),
                "last_used_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_used_at").ok().flatten(),
                "revoked_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").ok(),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[post("/scim/tokens")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_scim_token(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateScimTokenInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    // Org-scope managers can only mint tokens for their own org.
    if ctx.scope == rbac::Scope::Organization && ctx.organization_id != Some(data.organization_id) {
        return Err(AppError::Forbidden);
    }
    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    let (raw, hash, preview) = generate();
    let row = sqlx::query(
        r#"
        INSERT INTO scim_tokens (organization_id, name, token_hash, token_preview, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, organization_id, name, token_preview, last_used_at, revoked_at, created_at
        "#,
    )
    .bind(data.organization_id)
    .bind(name)
    .bind(&hash)
    .bind(&preview)
    .bind(ctx.user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or(0),
        "organization_id": row.try_get::<i32, _>("organization_id").unwrap_or(0),
        "name": row.try_get::<String, _>("name").unwrap_or_default(),
        "token": raw, // shown ONCE
        "token_preview": row.try_get::<String, _>("token_preview").unwrap_or_default(),
        "scim_endpoint": "/scim/v2",
    })))
}

#[delete("/scim/tokens/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn revoke_scim_token(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    let id = path.into_inner();
    let done = sqlx::query(
        "UPDATE scim_tokens SET revoked_at = NOW() \
         WHERE id = $1 \
           AND ($2::INTEGER IS NULL OR organization_id = $2) \
           AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(if ctx.scope == rbac::Scope::Platform {
        None::<i32>
    } else {
        ctx.organization_id
    })
    .execute(pool.get_ref())
    .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("scim token"));
    }
    let _ = sha256_hex; // keep helper exported for tests
    Ok(HttpResponse::Ok().json(serde_json::json!({ "revoked": true })))
}
