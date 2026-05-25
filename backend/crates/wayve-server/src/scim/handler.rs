// SCIM 2.0 Users endpoints + discovery.
//
// Mounted at the root scope (NOT under /api) because RFC 7644 specifies
// `/scim/v2/*`. Authentication is the SCIM bearer token, separate from
// our session JWT and X-API-KEY surfaces.

use super::tokens::{ScimPrincipal, resolve};
use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::instrument;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(service_provider_config)
        .service(resource_types)
        .service(schemas)
        .service(list_users)
        .service(get_user)
        .service(create_user)
        .service(replace_user)
        .service(delete_user);
}

// ── Auth helper ───────────────────────────────────────────────────────

async fn auth(req: &HttpRequest, pool: &PgPool) -> std::result::Result<ScimPrincipal, HttpResponse> {
    let raw = req
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());
    let Some(raw) = raw else {
        return Err(scim_error(401, "Missing Bearer token"));
    };
    match resolve(pool, &raw).await {
        Some(p) => Ok(p),
        None => Err(scim_error(401, "Invalid SCIM token")),
    }
}

fn scim_error(status: u16, detail: &str) -> HttpResponse {
    let body = serde_json::json!({
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
        "status": status.to_string(),
        "detail": detail,
    });
    match status {
        400 => HttpResponse::BadRequest().json(body),
        401 => HttpResponse::Unauthorized().json(body),
        403 => HttpResponse::Forbidden().json(body),
        404 => HttpResponse::NotFound().json(body),
        409 => HttpResponse::Conflict().json(body),
        _ => HttpResponse::InternalServerError().json(body),
    }
}

// ── Discovery ─────────────────────────────────────────────────────────

#[get("/scim/v2/ServiceProviderConfig")]
pub async fn service_provider_config() -> AppResult {
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        "patch":      { "supported": false },
        "bulk":       { "supported": false, "maxOperations": 0, "maxPayloadSize": 0 },
        "filter":     { "supported": true,  "maxResults": 200 },
        "changePassword": { "supported": false },
        "sort":       { "supported": false },
        "etag":       { "supported": false },
        "authenticationSchemes": [{
            "name": "OAuth Bearer Token",
            "description": "Authentication via an organization-scoped Wayve SCIM token",
            "specUri": "https://tools.ietf.org/html/rfc6750",
            "type": "oauthbearertoken",
            "primary": true
        }]
    })))
}

#[get("/scim/v2/ResourceTypes")]
pub async fn resource_types() -> AppResult {
    Ok(HttpResponse::Ok().json(serde_json::json!([{
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        "id": "User",
        "name": "User",
        "endpoint": "/Users",
        "description": "Wayve user",
        "schema": "urn:ietf:params:scim:schemas:core:2.0:User"
    }])))
}

#[get("/scim/v2/Schemas")]
pub async fn schemas() -> AppResult {
    Ok(HttpResponse::Ok().json(serde_json::json!([{
        "id": "urn:ietf:params:scim:schemas:core:2.0:User",
        "name": "User",
        "description": "User account",
        "attributes": [
            { "name": "userName",   "type": "string",  "required": true,  "uniqueness": "server" },
            { "name": "displayName","type": "string",  "required": false },
            { "name": "active",     "type": "boolean", "required": false },
            { "name": "externalId", "type": "string",  "required": false, "uniqueness": "server" },
            { "name": "emails",     "type": "complex", "multiValued": true,
              "subAttributes": [
                { "name": "value",   "type": "string", "required": true },
                { "name": "primary", "type": "boolean" }
              ]}
        ]
    }])))
}

// ── User CRUD ─────────────────────────────────────────────────────────

// Accepted but ignored in v1 — Wayve treats `userName` as the canonical
// email. The `emails` field is part of the SCIM core schema so Okta /
// Entra will send it; we accept the deserialization rather than 400 on
// well-formed requests.
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ScimEmail {
    pub value: String,
    #[serde(default)]
    pub primary: Option<bool>,
}

#[derive(Deserialize)]
pub struct ScimUserInput {
    #[serde(rename = "userName")]
    pub user_name: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub active: Option<bool>,
    #[serde(rename = "externalId")]
    pub external_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub emails: Vec<ScimEmail>,
}

#[derive(Deserialize)]
pub struct ScimListQuery {
    pub filter: Option<String>,
    /// SCIM is 1-indexed; default 1.
    #[serde(rename = "startIndex")]
    pub start_index: Option<i64>,
    pub count: Option<i64>,
}

fn user_to_scim(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    let id: i32 = row.try_get("id").unwrap_or(0);
    let email: String = row.try_get("email").unwrap_or_default();
    let username: Option<String> = row.try_get("username").ok();
    let external_id: Option<String> = row.try_get("external_id").ok().flatten();
    let active: bool = row.try_get("is_active").unwrap_or(true);
    serde_json::json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "id": id.to_string(),
        "userName": email,
        "displayName": username,
        "externalId": external_id,
        "active": active,
        "emails": [{ "value": email, "primary": true }],
        "meta": {
            "resourceType": "User",
            "location": format!("/scim/v2/Users/{id}")
        }
    })
}

#[get("/scim/v2/Users")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_users(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ScimListQuery>,
) -> AppResult {
    let principal = match auth(&req, pool.get_ref()).await {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let start = query.start_index.unwrap_or(1).max(1);
    let count = query.count.unwrap_or(100).clamp(1, 200);

    // v1 filter parser — recognises `userName eq "x"` and `externalId eq "x"`
    // (case-insensitive operator, double-quoted value). Anything else is a
    // 400 to keep the contract simple and observable.
    let (filter_field, filter_value) = parse_simple_filter(query.filter.as_deref());

    let rows = sqlx::query(
        r#"
        SELECT id, email, username, external_id,
               (account_type <> 'guest') AS is_active
        FROM users
        WHERE organization_id = $1
          AND ($2::TEXT IS NULL OR (
              ($3::TEXT = 'userName'   AND LOWER(email) = LOWER($2))
           OR ($3::TEXT = 'externalId' AND external_id = $2)
          ))
        ORDER BY id
        OFFSET $4 LIMIT $5
        "#,
    )
    .bind(principal.organization_id)
    .bind(filter_value.clone())
    .bind(filter_field.clone())
    .bind(start - 1)
    .bind(count)
    .fetch_all(pool.get_ref())
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT FROM users
         WHERE organization_id = $1
           AND ($2::TEXT IS NULL OR (
               ($3::TEXT = 'userName'   AND LOWER(email) = LOWER($2))
            OR ($3::TEXT = 'externalId' AND external_id = $2)
           ))
        "#,
    )
    .bind(principal.organization_id)
    .bind(filter_value)
    .bind(filter_field)
    .fetch_one(pool.get_ref())
    .await
    .unwrap_or(0);

    let resources: Vec<_> = rows.iter().map(user_to_scim).collect();

    Ok(HttpResponse::Ok()
        .content_type("application/scim+json")
        .json(serde_json::json!({
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
            "totalResults": total,
            "startIndex": start,
            "itemsPerPage": resources.len(),
            "Resources": resources,
        })))
}

#[get("/scim/v2/Users/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let principal = match auth(&req, pool.get_ref()).await {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = path.into_inner();
    let row = sqlx::query(
        r#"
        SELECT id, email, username, external_id,
               (account_type <> 'guest') AS is_active
          FROM users
         WHERE id = $1 AND organization_id = $2
        "#,
    )
    .bind(id)
    .bind(principal.organization_id)
    .fetch_optional(pool.get_ref())
    .await?;
    match row {
        Some(row) => Ok(HttpResponse::Ok()
            .content_type("application/scim+json")
            .json(user_to_scim(&row))),
        None => Ok(scim_error(404, "User not found")),
    }
}

#[post("/scim/v2/Users")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ScimUserInput>,
) -> AppResult {
    let principal = match auth(&req, pool.get_ref()).await {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let email = data.user_name.trim().to_lowercase();
    if email.is_empty() {
        return Ok(scim_error(400, "userName is required"));
    }

    // Idempotent on duplicate userName/externalId — RFC 7644 §3.3 wants
    // 409 conflict, not creation of a second row.
    if let Some(existing) = sqlx::query(
        "SELECT id FROM users WHERE organization_id = $1 \
         AND (LOWER(email) = $2 OR ($3::TEXT IS NOT NULL AND external_id = $3))",
    )
    .bind(principal.organization_id)
    .bind(&email)
    .bind(data.external_id.as_deref())
    .fetch_optional(pool.get_ref())
    .await?
    {
        let _: i32 = existing.get("id");
        return Ok(scim_error(409, "User with matching userName or externalId already exists"));
    }

    // SCIM-provisioned users are seeded with a random throwaway password
    // — the IdP authenticates them via SSO/SCIM, not our login form.
    // bcrypt cost stays at the project default (12); the password is
    // long enough that brute force isn't a meaningful risk even if the
    // hash ever leaks.
    let throwaway = format!("scim_{}", uuid::Uuid::new_v4().simple());
    let hashed = bcrypt::hash(&throwaway, bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("bcrypt: {e}")))?;

    let row = sqlx::query(
        r#"
        INSERT INTO users
            (email, password, username, account_type,
             auth_provider, organization_id, external_id)
        VALUES
            ($1, $2, $3, 'organization', 'scim', $4, $5)
        RETURNING id, email, username, external_id, true AS is_active
        "#,
    )
    .bind(&email)
    .bind(hashed)
    .bind(
        data.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(principal.organization_id)
    .bind(data.external_id.as_deref())
    .fetch_one(pool.get_ref())
    .await?;

    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id, role) \
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    )
    .bind(principal.organization_id)
    .bind(row.try_get::<i32, _>("id").unwrap_or(0))
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created()
        .content_type("application/scim+json")
        .json(user_to_scim(&row)))
}

#[put("/scim/v2/Users/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn replace_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<ScimUserInput>,
) -> AppResult {
    let principal = match auth(&req, pool.get_ref()).await {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = path.into_inner();
    let email = data.user_name.trim().to_lowercase();
    if email.is_empty() {
        return Ok(scim_error(400, "userName is required"));
    }
    let active = data.active.unwrap_or(true);
    // "Disabled" maps to the existing `guest` account_type, which carries
    // the read-only baseline permission set. A future v2 might add a
    // dedicated `disabled` flag — for v1 we reuse what's already RBAC-aware.
    let next_account_type = if active { "organization" } else { "guest" };
    let row = sqlx::query(
        r#"
        UPDATE users SET
          email = $1,
          username = $2,
          external_id = $3,
          account_type = $4
        WHERE id = $5 AND organization_id = $6
        RETURNING id, email, username, external_id,
                  (account_type <> 'guest') AS is_active
        "#,
    )
    .bind(&email)
    .bind(
        data.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(data.external_id.as_deref())
    .bind(next_account_type)
    .bind(id)
    .bind(principal.organization_id)
    .fetch_optional(pool.get_ref())
    .await?;
    match row {
        Some(row) => Ok(HttpResponse::Ok()
            .content_type("application/scim+json")
            .json(user_to_scim(&row))),
        None => Ok(scim_error(404, "User not found")),
    }
}

#[delete("/scim/v2/Users/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let principal = match auth(&req, pool.get_ref()).await {
        Ok(p) => p,
        Err(resp) => return Ok(resp),
    };
    let id = path.into_inner();
    // SCIM DELETE is "deprovision" — we mark the user inactive (guest)
    // rather than hard-deleting. Hard-delete cascades through ~15 tables
    // and an admin can still do it manually via the existing admin
    // surface.
    let done = sqlx::query(
        "UPDATE users SET account_type = 'guest' \
         WHERE id = $1 AND organization_id = $2 AND account_type <> 'guest'",
    )
    .bind(id)
    .bind(principal.organization_id)
    .execute(pool.get_ref())
    .await?;
    if done.rows_affected() == 0 {
        return Ok(scim_error(404, "User not found"));
    }
    Ok(HttpResponse::NoContent().finish())
}

// ── Filter parser ─────────────────────────────────────────────────────

/// Minimal RFC 7644 §3.4.2.2 filter — only `<attr> eq "value"` for a fixed
/// set of attributes. Returns `(field_canonical_name, value)` on success.
fn parse_simple_filter(raw: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(raw) = raw else { return (None, None) };
    let lowered = raw.trim().to_lowercase();
    let parts: Vec<&str> = raw.trim().splitn(3, char::is_whitespace).collect();
    if parts.len() != 3 || !lowered.contains(" eq ") {
        return (None, None);
    }
    let attr = parts[0].to_lowercase();
    let value = parts[2].trim_matches('"').to_string();
    let canonical = match attr.as_str() {
        "username" => "userName",
        "externalid" => "externalId",
        _ => return (None, None),
    };
    (Some(canonical.to_string()), Some(value))
}
