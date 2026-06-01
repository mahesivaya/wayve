//! Organization-scoped API key endpoints: `/admin/organizations/{id}/keys`
//! and the `X-API-KEY` whoami probe `/v1/me`.
//!
//! Distinct from `routes::api_keys`, which manages the general-purpose key
//! catalog gated by `api_keys:manage`.

use crate::prelude::*;
use actix_web::delete;
use chrono::{DateTime, Utc};
use tracing::{info, instrument};
use wayve_security::api_key::{generate_api_key, hash_api_key};
use wayve_security::rbac::{self, Permission};

#[derive(Deserialize)]
pub struct GenerateApiKeyInput {
    pub name: String,
}

/// A stored API key as exposed to the admin UI — only the redacted preview,
/// never the raw key or its hash.
#[derive(Serialize, FromRow)]
pub struct ApiKeyRow {
    pub id: i32,
    pub name: String,
    pub key_preview: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[post("/admin/organizations/{id}/keys")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn admin_generate_api_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<GenerateApiKeyInput>,
) -> AppResult {
    let organization_id = path.into_inner();
    let admin_id = match rbac::require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::ApiKeysManage,
    )
    .await
    {
        Ok(ctx) => ctx.user_id,
        Err(response) => return Ok(response),
    };

    let key_name = data.name.trim();
    if key_name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Key name is required" })));
    }

    // Clean 404 instead of a foreign-key 500 when the org id is wrong.
    let org_exists = sqlx::query_scalar::<_, i32>("SELECT id FROM organizations WHERE id = $1")
        .bind(organization_id)
        .fetch_optional(pool.get_ref())
        .await?;
    if org_exists.is_none() {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Unknown organization" }))
        );
    }

    // The raw key is returned to the caller exactly once; only its SHA-256
    // hash is persisted, so a leaked database never exposes usable keys.
    let raw_key = generate_api_key();
    let key_hash = hash_api_key(&raw_key);
    let key_preview = format!("{}...{}", &raw_key[..10], &raw_key[raw_key.len() - 4..]);

    let row = sqlx::query(
        r#"
        INSERT INTO api_keys (organization_id, name, key_hash, key_preview, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, key_preview, created_at
        "#,
    )
    .bind(organization_id)
    .bind(key_name)
    .bind(&key_hash)
    .bind(&key_preview)
    .bind(admin_id)
    .fetch_one(pool.get_ref())
    .await?;

    info!(target: "auth", admin_id, organization_id, "api key generated");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "key_preview": row.get::<String, _>("key_preview"),
        "created_at": row.get::<DateTime<Utc>, _>("created_at"),
        "api_key": raw_key,
    })))
}

#[get("/admin/organizations/{id}/keys")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn admin_list_api_keys(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let organization_id = path.into_inner();
    if let Err(response) = rbac::require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::ApiKeysManage,
    )
    .await
    {
        return Ok(response);
    }

    let rows = sqlx::query_as::<_, ApiKeyRow>(
        r#"
        SELECT id, name, key_preview, created_at, last_used_at, revoked_at
          FROM api_keys
         WHERE organization_id = $1
         ORDER BY created_at DESC
        "#,
    )
    .bind(organization_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[delete("/admin/organizations/{id}/keys/{key_id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn admin_revoke_api_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, key_id) = path.into_inner();
    let admin_id = match rbac::require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::ApiKeysManage,
    )
    .await
    {
        Ok(ctx) => ctx.user_id,
        Err(response) => return Ok(response),
    };

    let result = sqlx::query(
        r#"
        UPDATE api_keys SET revoked_at = NOW()
         WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
        "#,
    )
    .bind(key_id)
    .bind(organization_id)
    .execute(pool.get_ref())
    .await?;

    if result.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Key not found or already revoked" })));
    }
    info!(target: "auth", admin_id, organization_id, key_id, "api key revoked");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "revoked": true })))
}

/// Resolve an `X-API-KEY` request header to the owning organization id.
/// O(1): an indexed lookup on the unique `key_hash` column. Returns `None`
/// for a missing, malformed, unknown, or revoked key, and stamps last_used_at.
pub async fn validate_api_key(req: &HttpRequest, pool: &PgPool) -> Option<i32> {
    let api_key = req.headers().get("X-API-KEY")?.to_str().ok()?;
    let key_hash = hash_api_key(api_key);

    sqlx::query_scalar::<_, i32>(
        r#"
        UPDATE api_keys SET last_used_at = NOW()
         WHERE key_hash = $1 AND revoked_at IS NULL
         RETURNING organization_id
        "#,
    )
    .bind(&key_hash)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

#[get("/v1/me")]
#[instrument(target = "http", skip(req, pool))]
pub async fn api_key_whoami(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let organization_id = match validate_api_key(&req, pool.get_ref()).await {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Invalid or missing API key" }));
        }
    };

    let name: Option<String> = sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(organization_id)
        .fetch_optional(pool.get_ref())
        .await
        .ok()
        .flatten();

    HttpResponse::Ok().json(serde_json::json!({
        "organization_id": organization_id,
        "name": name,
    }))
}
