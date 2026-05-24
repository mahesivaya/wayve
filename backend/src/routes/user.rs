use crate::billing::entitlements::effective_entitlements;
use crate::billing::models::BillingOwner;
use crate::cache::TtlCache;
use crate::email::profile::invalidate_me_cache;
use crate::models::auth::ChangePasswordInput;
use crate::models::email_request::UserResponse;
use crate::prelude::*;
use crate::security::api_key::{generate_api_key, hash_api_key};
use crate::security::jwt::get_user_id_from_request;
use crate::security::password::{hash_password, verify_password};
use crate::security::rbac::{self, Permission, Role, Scope};
use actix_web::{HttpRequest, HttpResponse, Responder, delete, get, post, put, web};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};

const PROFILE_CACHE_TTL_SECS: u64 = 30;
const PROFILE_CACHE_MAX_CAPACITY: u64 = 5000;

static PROFILE_CACHE: Lazy<TtlCache<i32, serde_json::Value>> =
    Lazy::new(|| TtlCache::new(PROFILE_CACHE_MAX_CAPACITY, PROFILE_CACHE_TTL_SECS));

pub async fn invalidate_profile_cache(user_id: i32) {
    PROFILE_CACHE.invalidate(&user_id).await;
}

/// Canonical account-type string. `account_type` is a plain TEXT column;
/// anything unrecognized normalizes to "personal".
pub fn normalized_account_type(value: &str) -> &str {
    match value {
        "organization" | "organization_admin" | "platform_admin" => value,
        _ => "personal",
    }
}

/// Organization name as shown to the current user.
///
/// Personal accounts do not belong to an organization, but the UI displays the
/// email address in that slot so account headers stay consistent.
pub fn display_organization_name(
    account_type: &str,
    email: &str,
    organization_name: Option<String>,
) -> Option<String> {
    if normalized_account_type(account_type) == "personal" {
        Some(email.to_string())
    } else {
        organization_name
    }
}

pub fn normalized_org_role(value: &str) -> &str {
    match value {
        "owner" | "super_admin" | "admin" | "security" | "billing" | "developer" | "support"
        | "member" | "guest" => value,
        _ => "member",
    }
}

pub fn normalized_platform_role(value: &str) -> &str {
    match value {
        "owner" | "super_admin" | "admin" | "security" | "billing" | "developer" | "support"
        | "member" | "guest" => value,
        _ => "member",
    }
}

fn default_role_for_account_type(account_type: &str) -> &'static str {
    match normalized_account_type(account_type) {
        "organization_admin" => "owner",
        "organization" => "member",
        "platform_admin" => "owner",
        _ => "owner",
    }
}

fn role_label(role: &str, account_type: &str) -> &'static str {
    match normalized_account_type(account_type) {
        "personal" => "Personal workspace owner",
        "platform_admin" => match normalized_platform_role(role) {
            "owner" => "Platform owner",
            "super_admin" => "Platform super admin",
            "admin" => "Platform admin",
            "security" => "Platform security",
            "billing" => "Platform billing",
            "developer" => "Platform developer",
            "support" => "Platform support",
            "guest" => "Platform guest",
            _ => "Platform member",
        },
        _ => match normalized_org_role(role) {
            "owner" => "Organization owner",
            "super_admin" => "Organization super admin",
            "admin" => "Organization admin",
            "security" => "Organization security",
            "billing" => "Organization billing",
            "developer" => "Developer",
            "support" => "Support",
            "guest" => "Guest",
            _ => "Member",
        },
    }
}

/// Resolve a user's effective role string and its display label.
///
/// Delegates to `rbac::resolve_role_context` so role resolution lives in one
/// place; this wrapper only adds the scope-prefixed human label.
pub async fn effective_role_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<(String, String), sqlx::Error> {
    let ctx = rbac::resolve_role_context(pool, user_id).await?;
    Ok((
        ctx.role.as_str().to_string(),
        effective_role_label(ctx.scope, ctx.role),
    ))
}

/// Scope-prefixed display label for a resolved role.
fn effective_role_label(scope: Scope, role: Role) -> String {
    match scope {
        Scope::Personal => "Personal workspace owner".to_string(),
        Scope::Platform => format!("Platform {}", role.label().to_lowercase()),
        Scope::Organization => match role {
            Role::Owner => "Organization owner".to_string(),
            Role::SuperAdmin => "Organization super admin".to_string(),
            Role::Admin => "Organization admin".to_string(),
            Role::Security => "Organization security".to_string(),
            Role::Billing => "Organization billing".to_string(),
            Role::Developer => "Developer".to_string(),
            Role::Support => "Support".to_string(),
            Role::Member => "Member".to_string(),
            Role::Guest => "Guest".to_string(),
        },
    }
}

/// A user's resolved access — role, scope, and the permission strings the
/// frontend uses to gate UI. Returned by `/api/me` and `/profile`.
pub struct EffectiveAccess {
    pub role: String,
    pub role_label: String,
    pub scope: String,
    pub permissions: Vec<String>,
}

/// A snapshot of the user's current plan, suitable for embedding in the
/// `/api/me` / `/api/profile` response. The frontend uses `code` + `name`
/// to render the tier badge and decide whether to show the "Upgrade" CTA.
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct CurrentPlan {
    pub code: String,
    pub name: String,
    pub audience: String,
    pub amount_cents: i64,
}

/// Resolve the user's current tier.
///
/// Strategy:
///   1. Active personal subscription for this user → its plan.
///   2. Active organization subscription via the user's org → its plan
///      (org members inherit the org plan).
///   3. Fall back to the `basic_user` plan row — the canonical free tier.
///      Every newly-registered user lands here until they subscribe; we
///      don't insert a redundant subscriptions row to avoid table clutter.
pub async fn current_plan_for_user(
    pool: &PgPool,
    user_id: i32,
    organization_id: Option<i32>,
) -> Result<CurrentPlan, sqlx::Error> {
    if let Some(plan) = sqlx::query_as::<_, CurrentPlan>(
        r#"
        SELECT p.code, p.name, p.audience, p.amount_cents
          FROM subscriptions s
          JOIN plans p ON p.id = s.plan_id
         WHERE s.status = 'active'
           AND s.user_id = $1
         ORDER BY s.id DESC
         LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(plan);
    }

    if let Some(org_id) = organization_id
        && let Some(plan) = sqlx::query_as::<_, CurrentPlan>(
            r#"
            SELECT p.code, p.name, p.audience, p.amount_cents
              FROM subscriptions s
              JOIN plans p ON p.id = s.plan_id
             WHERE s.status = 'active'
               AND s.organization_id = $1
             ORDER BY s.id DESC
             LIMIT 1
            "#,
        )
        .bind(org_id)
        .fetch_optional(pool)
        .await?
    {
        return Ok(plan);
    }

    sqlx::query_as::<_, CurrentPlan>(
        "SELECT code, name, audience, amount_cents FROM plans WHERE code = 'basic_user'",
    )
    .fetch_one(pool)
    .await
}

/// Full access info for a user, computed from the RBAC role context.
pub async fn effective_access_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<EffectiveAccess, sqlx::Error> {
    let ctx = rbac::resolve_role_context(pool, user_id).await?;
    Ok(EffectiveAccess {
        role: ctx.role.as_str().to_string(),
        role_label: effective_role_label(ctx.scope, ctx.role),
        scope: ctx.scope.as_str().to_string(),
        permissions: ctx.permission_strings(),
    })
}

/// Best-effort access used only when the role-context query fails (a DB error).
/// Derives scope/role from the account_type the caller already holds.
pub fn fallback_access(account_type: &str) -> EffectiveAccess {
    let (scope, role) = match normalized_account_type(account_type) {
        "platform_admin" => (Scope::Platform, Role::Owner),
        "organization_admin" => (Scope::Organization, Role::Owner),
        "organization" => (Scope::Organization, Role::Member),
        _ => (Scope::Personal, Role::Owner),
    };
    EffectiveAccess {
        role: role.as_str().to_string(),
        role_label: effective_role_label(scope, role),
        scope: scope.as_str().to_string(),
        permissions: rbac::permissions_for(role)
            .iter()
            .map(|perm| perm.as_str().to_string())
            .collect(),
    }
}

#[derive(Deserialize)]
pub struct UserLookupQuery {
    pub email: String,
}

#[get("/users")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_user_by_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<UserLookupQuery>,
) -> AppResult {
    // Require a valid JWT — this endpoint exposes user ids and public keys,
    // so it must not be reachable anonymously.
    if get_user_id_from_request(&req).is_none() {
        return Ok(HttpResponse::Unauthorized().finish());
    }

    let email = query.email.trim();
    if email.is_empty() {
        return Ok(HttpResponse::BadRequest().body("Email required"));
    }

    let user = sqlx::query_as::<_, UserResponse>(
        "SELECT id, email, public_key FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool.get_ref())
    .await?;

    match user {
        Some(user) => {
            let parsed_key = user
                .public_key
                .and_then(|k| serde_json::from_str::<Vec<u8>>(&k).ok());

            Ok(HttpResponse::Ok().json(serde_json::json!({
                "id": user.id,
                "email": user.email,
                "public_key": parsed_key
            })))
        }
        None => Ok(HttpResponse::Ok().json(serde_json::json!(null))),
    }
}

use sqlx::Row;

#[derive(Deserialize)]
pub struct ProfileUpdate {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

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

#[derive(Deserialize)]
pub struct AdminCreateUserInput {
    // Both username and password are now optional. When the caller is using
    // the simple "Create user" admin flow (provide an email + role), we
    // derive `username` from the email's local-part and generate a strong
    // random `password` on the server. The plaintext is returned to the
    // admin exactly once in the response so they can share it with the new
    // user out-of-band.
    #[serde(default)]
    pub username: Option<String>,
    pub email: String,
    #[serde(default)]
    pub password: Option<String>,
    pub account_type: Option<String>,
    pub organization_name: Option<String>,
    // Optional role override. When omitted, the existing
    // `default_role_for_account_type` rules apply (owner for admin scopes,
    // member for organization). The DB CHECK constraint on
    // organization_members.role / platform_members.role is the final filter
    // for invalid strings.
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateOrganizationInput {
    pub name: String,
    /// Optional organization admin to provision together with the organization. When
    /// any of the three fields is supplied, all three are required.
    pub admin_username: Option<String>,
    pub admin_email: Option<String>,
    pub admin_password: Option<String>,
}

/// Require the caller to be platform-scope staff holding `members:manage` — the
/// gate for platform-only actions such as provisioning organizations. Platform
/// `owner`, `super_admin`, and `admin` qualify. Returns the caller's user id.
async fn require_platform_admin(req: &HttpRequest, pool: &PgPool) -> Result<i32, HttpResponse> {
    let ctx = rbac::require_permission(req, pool, Permission::MembersManage).await?;
    if ctx.scope != Scope::Platform {
        return Err(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform staff access required" })));
    }
    Ok(ctx.user_id)
}

#[get("/admin/organizations")]
#[instrument(target = "http", skip(req, pool))]
pub async fn admin_list_organizations(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let list_ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersRead)
        .await
    {
        Ok(ctx) => Ok(ctx),
        Err(_) => rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await,
    };

    match list_ctx {
        Ok(ctx) if ctx.scope == Scope::Platform => {}
        Ok(_) => {
            return Ok(HttpResponse::Forbidden()
                .json(serde_json::json!({ "message": "Platform staff access required" })));
        }
        Err(response) => return Ok(response),
    }

    let rows = sqlx::query(
        r#"
        SELECT
            o.id,
            o.name,
            o.slug,
            o.created_at,
            COUNT(u.id) AS user_count,
            (SELECT json_build_object('id', u2.id, 'email', u2.email) 
             FROM users u2 
             WHERE u2.organization_id = o.id AND u2.account_type = 'organization_admin'
             LIMIT 1) as admin
        FROM organizations o
        LEFT JOIN users u ON u.organization_id = o.id
        GROUP BY o.id, o.name, o.slug, o.created_at
        ORDER BY o.name
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let organizations: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let id: i32 = row.get("id");
            let name: String = row.get("name");
            let slug: Option<String> = row.get("slug");
            let user_count: i64 = row.get("user_count");
            let admin: Option<serde_json::Value> = row.get("admin");

            serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "user_count": user_count,
                "admin": admin
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(organizations))
}

#[post("/admin/organizations")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn admin_create_organization(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateOrganizationInput>,
) -> AppResult {
    let admin_id = match require_platform_admin(&req, pool.get_ref()).await {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };

    let name = data.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is required" })));
    }

    // The organization admin block is optional, but if any field is supplied the
    // whole set (username, email, password) must be present.
    let admin_username = data
        .admin_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let admin_email = data
        .admin_email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let admin_password = data
        .admin_password
        .as_deref()
        .filter(|value| !value.is_empty());

    let organization_admin =
        if admin_username.is_some() || admin_email.is_some() || admin_password.is_some() {
            match (admin_username, admin_email.as_deref(), admin_password) {
                (Some(username), Some(email), Some(password)) => {
                    if password.len() < 6 {
                        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                            "message": "Password must be at least 6 characters"
                        })));
                    }
                    Some((
                        username.to_string(),
                        email.to_string(),
                        password.to_string(),
                    ))
                }
                _ => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "Organization admin username, email, and password are all required"
                })));
                }
            }
        } else {
            None
        };

    let mut tx = pool.begin().await?;

    // The slug is derived from the name at insert time (same expression as the
    // init.sql backfill) so runtime-created orgs are never left slug-less.
    // On a name conflict it heals a missing slug but never overwrites one,
    // keeping existing slugs stable.
    let org_row = match sqlx::query(
        r#"
        INSERT INTO organizations (name, slug)
        VALUES ($1, lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')))
        ON CONFLICT (name) DO UPDATE
            SET slug = COALESCE(organizations.slug, EXCLUDED.slug)
        RETURNING id, name, slug
        "#,
    )
    .bind(name)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::Conflict().json(serde_json::json!({
                    "message": "Another organization already uses that URL slug"
                })));
            }
            return Err(AppError::Db(e));
        }
    };

    let organization_id: i32 = org_row.get("id");
    let organization_name: String = org_row.get("name");
    let organization_slug: Option<String> = org_row.get("slug");

    let mut admin_json = serde_json::Value::Null;

    if let Some((username, email, password)) = organization_admin {
        let hashed = hash_password(&password).await?;

        match sqlx::query(
            r#"
            INSERT INTO users (username, email, password, auth_provider, account_type, organization_id)
            VALUES ($1, $2, $3, 'local', $4, $5)
            RETURNING id, username, email, account_type, organization_id
            "#,
        )
        .bind(&username)
        .bind(&email)
        .bind(&hashed)
        .bind("organization_admin")
        .bind(organization_id)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(row) => {
                let id: i32 = row.get("id");
                let username: Option<String> = row.try_get("username").ok();
                let email: String = row.get("email");
                let account_type: String = row.get("account_type");
                let org_id: Option<i32> = row.try_get("organization_id").ok().flatten();
                admin_json = serde_json::json!({
                    "id": id,
                    "username": username,
                    "email": email,
                    "account_type": account_type, // Use the enum directly
                    "organization_id": org_id
                });

                sqlx::query(
                    r#"
                    INSERT INTO organization_members (organization_id, user_id, role)
                    VALUES ($1, $2, 'owner')
                    ON CONFLICT (organization_id, user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(organization_id)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            Err(e) => {
                if e.to_string().contains("duplicate key") {
                    return Ok(HttpResponse::Conflict().json(serde_json::json!({
                        "message": "A user with that username or email already exists"
                    })));
                }
                return Err(AppError::Db(e));
            }
        }
    }

    tx.commit().await?;

    let user_count = if admin_json.is_null() { 0 } else { 1 };
    info!(target: "auth", admin_id, organization_id, "platform admin created organization");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": organization_id,
        "name": organization_name,
        "slug": organization_slug,
        "user_count": user_count,
        "admin": admin_json
    })))
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

#[post("/admin/users")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn admin_create_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<AdminCreateUserInput>,
) -> AppResult {
    // Creating accounts requires `members:manage` — held by org and platform
    // owner / super_admin / admin. This replaces the old account_type check, so
    // an organization `admin` (not just `organization_admin`) can add members.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let admin_id = ctx.user_id;

    let email = data.email.trim().to_lowercase();
    // Username defaults to the email local-part so admins can create a user
    // with just an email. Existing callers that still send `username` keep
    // working.
    let username_owned = data
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            email
                .split('@')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or(&email)
                .to_string()
        });
    let username = username_owned.as_str();
    let requested_account_type = data
        .account_type
        .as_deref()
        .map(normalized_account_type)
        .unwrap_or("personal");

    // Platform staff may provision any account type; an organization manager
    // may only add "organization" members to their own organization.
    let account_type: &str = match ctx.scope {
        Scope::Platform => match requested_account_type {
            "organization_admin" | "platform_admin" | "organization" | "personal" => {
                requested_account_type
            }
            _ => "personal",
        },
        Scope::Organization => "organization",
        Scope::Personal => "personal",
    };

    if username.is_empty() || email.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Email is required" })));
    }

    // Decide the working password before hashing:
    //   - If the admin supplied a non-empty value, use it (minimum 6 chars).
    //   - Otherwise, generate a 16-char alphanumeric temp password and
    //     return it in the response so the admin can share it once.
    let supplied_password = data
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (plaintext_password, generated) = match supplied_password {
        Some(value) if value.len() < 6 => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Password must be at least 6 characters" })));
        }
        Some(value) => (value.to_string(), false),
        None => (generate_temp_password(), true),
    };

    let organization_id: Option<i32> = if account_type == "organization_admin" {
        let organization_name = data
            .organization_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let Some(organization_name) = organization_name else {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Organization name is required for organization admin accounts" })));
        };

        match sqlx::query(
            r#"
            INSERT INTO organizations (name, slug)
            VALUES ($1, lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')))
            ON CONFLICT (name) DO UPDATE
                SET slug = COALESCE(organizations.slug, EXCLUDED.slug)
            RETURNING id
            "#,
        )
        .bind(organization_name)
        .fetch_one(pool.get_ref())
        .await
        {
            Ok(row) => Some(row.get("id")),
            Err(e) => {
                if e.to_string().contains("duplicate key") {
                    return Ok(HttpResponse::Conflict().json(serde_json::json!({
                        "message": "Another organization already uses that URL slug"
                    })));
                }
                return Err(AppError::Db(e));
            }
        }
    } else if ctx.scope == Scope::Organization {
        match ctx.organization_id {
            Some(id) => Some(id),
            None => {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "Organization manager is not assigned to an organization"
                })));
            }
        }
    } else {
        None
    };

    if let Some(org_id) = organization_id {
        let entitlements =
            effective_entitlements(pool.get_ref(), BillingOwner::Organization(org_id)).await;
        if entitlements.seat_limit >= 0 {
            let seats_used = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)::BIGINT FROM users WHERE organization_id = $1",
            )
            .bind(org_id)
            .fetch_one(pool.get_ref())
            .await?;
            if seats_used >= i64::from(entitlements.seat_limit) {
                return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
                    "message": "Organization seat limit reached. Upgrade the plan before adding more members.",
                    "seat_limit": entitlements.seat_limit,
                    "seats_used": seats_used
                })));
            }
        }
    }

    let hashed = hash_password(&plaintext_password).await?;

    let result = sqlx::query(
        r#"
        INSERT INTO users (username, email, password, auth_provider, account_type)
        VALUES ($1, $2, $3, 'local', $4)
        RETURNING id, username, email, account_type, organization_id
        "#,
    )
    .bind(username)
    .bind(&email)
    .bind(&hashed)
    .bind(account_type)
    .fetch_one(pool.get_ref())
    .await;

    let result = if let (Ok(row), Some(organization_id)) = (&result, organization_id) {
        sqlx::query(
            "UPDATE users SET organization_id = $1 WHERE id = $2 RETURNING id, username, email, account_type, organization_id",
        )
        .bind(organization_id)
        .bind(row.get::<i32, _>("id"))
        .fetch_one(pool.get_ref())
        .await
    } else {
        result
    };

    match result {
        Ok(row) => {
            let id: i32 = row.get("id");
            let username: Option<String> = row.try_get("username").ok();
            let email: String = row.get("email");
            let account_type: String = row.get("account_type");
            let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
            // Role precedence: explicit input -> account-type default. The DB
            // CHECK constraints on platform_members / organization_members
            // reject anything outside the 9-role catalog, so a bad string
            // from a misbehaving client surfaces as a 500 below rather than
            // a silent default. That's intentional — the frontend dropdown
            // is restricted to the 4 roles we expose for this flow
            // (guest/developer/member/support) and only legitimate misuse
            // would land here.
            let role_owned = data
                .role
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let role: &str = role_owned
                .as_deref()
                .unwrap_or_else(|| default_role_for_account_type(&account_type));

            if normalized_account_type(&account_type) == "platform_admin" {
                sqlx::query(
                    r#"
                    INSERT INTO platform_members (user_id, role)
                    VALUES ($1, $2)
                    ON CONFLICT (user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(id)
                .bind(role)
                .execute(pool.get_ref())
                .await?;
            }

            if let Some(org_id) = organization_id {
                sqlx::query(
                    r#"
                    INSERT INTO organization_members (organization_id, user_id, role)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (organization_id, user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(org_id)
                .bind(id)
                .bind(role)
                .execute(pool.get_ref())
                .await?;
            }

            info!(target: "auth", admin_id, user_id = id, "admin created user");
            // `temp_password` is only present when the server generated it.
            // Existing callers that supplied a password get the same response
            // they did before, just without the plaintext echoed back.
            let mut body = serde_json::json!({
                "id": id,
                "username": username,
                "email": email,
                "account_type": account_type,
                "organization_id": organization_id,
                "role": role,
            });
            if generated {
                body["temp_password"] = serde_json::Value::String(plaintext_password);
            }
            Ok(HttpResponse::Created().json(body))
        }
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::Conflict()
                    .json(serde_json::json!({ "message": "Username or email already exists" })));
            }
            Err(AppError::Db(e))
        }
    }
}

fn generate_temp_password() -> String {
    use rand::{distributions::Alphanumeric, Rng};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect()
}

// Hard-delete a user account. Almost every related table has ON DELETE
// CASCADE on its user_id FK, so the single DELETE on `users` cleans up
// memberships, messages, files, billing customers, etc. The `notes` table
// has a `user_id` column but no FK constraint (init.sql:469), so it gets
// an explicit DELETE first to avoid orphan rows after the cascade.
//
// Authorization:
//   * Gate: `members:manage` (owner, super_admin, admin, security via the
//     RBAC change in this same PR).
//   * Role-level: actor must be able to assign the target's role
//     (`can_assign_role`). Without this an admin/security could delete the
//     org owner, which would be a privilege escalation.
//   * Scope: org-scoped actors can only delete users in their own org;
//     platform-scoped actors can delete anyone subject to the role check.
//   * Self-delete blocked — an admin removing themselves mid-session is
//     almost always a mistake, and the JWT remains valid until expiry so
//     they would lock themselves out of their own session.
//   * Last-owner: cannot delete the sole owner of an org/platform.
#[delete("/admin/users/{id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn admin_delete_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx =
        match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await {
            Ok(ctx) => ctx,
            Err(response) => return Ok(response),
        };
    let target_user_id = path.into_inner();

    if ctx.user_id == target_user_id {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "You cannot delete your own account" })));
    }

    // Resolve the target's effective role + scope so we can apply the same
    // assign-role gate that the role-change endpoint uses.
    let target_ctx = match rbac::resolve_role_context(pool.get_ref(), target_user_id).await {
        Ok(target_ctx) => target_ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "User not found" })));
        }
        Err(e) => return Err(AppError::Db(e)),
    };

    // Scope boundary: org admins cannot reach across orgs or into the
    // platform tenant. Platform admins are unconstrained by scope (but
    // still constrained by the role check below).
    match ctx.scope {
        Scope::Organization => {
            if target_ctx.scope != Scope::Organization
                || target_ctx.organization_id != ctx.organization_id
            {
                return Ok(HttpResponse::NotFound().json(serde_json::json!({
                    "message": "User is not a member of your organization"
                })));
            }
        }
        Scope::Platform => {}
        Scope::Personal => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Personal accounts cannot delete other users"
            })));
        }
    }

    // Role check: same predicate as role assignment. RolesManage holders
    // can delete anyone; RolesAssignLimited can only delete users whose
    // current role is below admin.
    if !rbac::can_assign_role(&ctx, target_ctx.role, target_ctx.role) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Your role cannot manage that account"
        })));
    }

    let mut tx = pool.begin().await?;

    // Last-owner protection. Lock the owner rows with FOR UPDATE so two
    // concurrent deletes can't both pass this check.
    if target_ctx.role == Role::Owner {
        let owner_count: i64 = match target_ctx.scope {
            Scope::Organization => {
                let org_id = target_ctx.organization_id.unwrap_or(-1);
                sqlx::query_scalar(
                    "SELECT COUNT(*)::BIGINT FROM organization_members \
                     WHERE organization_id = $1 AND role = 'owner' FOR UPDATE",
                )
                .bind(org_id)
                .fetch_one(&mut *tx)
                .await?
            }
            Scope::Platform => {
                sqlx::query_scalar(
                    "SELECT COUNT(*)::BIGINT FROM platform_members \
                     WHERE role = 'owner' FOR UPDATE",
                )
                .fetch_one(&mut *tx)
                .await?
            }
            Scope::Personal => 0,
        };
        if owner_count <= 1 {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Cannot delete the last owner"
            })));
        }
    }

    // Notes has user_id but no FK (see init.sql:469) — clean explicitly so
    // it doesn't leave orphan rows after the users-row cascade. Every other
    // user-owned table has ON DELETE CASCADE on its FK.
    sqlx::query("DELETE FROM notes WHERE user_id = $1")
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        // Race: target existed at resolve_role_context time, gone now.
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
        );
    }

    tx.commit().await?;

    invalidate_me_cache(target_user_id).await;
    invalidate_profile_cache(target_user_id).await;
    info!(
        target: "auth",
        actor = ctx.user_id,
        target_user_id,
        scope = ?target_ctx.scope,
        "admin deleted user"
    );

    Ok(HttpResponse::NoContent().finish())
}

#[get("/profile")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_profile(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if let Some(cached) = PROFILE_CACHE.get(&user_id).await {
        return Ok(HttpResponse::Ok().json(cached));
    }

    let result = sqlx::query(
        r#"
        SELECT
            u.id, u.email, u.first_name, u.last_name, u.auth_provider, u.account_type, u.organization_id, u.username, u.recovery_mode,
            o.name as organization_name,
            (SELECT COUNT(*)::BIGINT FROM emails e JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = u.id) as total_emails,
            (SELECT COALESCE(SUM(octet_length(body_encrypted)), 0)::BIGINT FROM emails e JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = u.id) as email_storage_bytes,
            (SELECT COALESCE(SUM(size), 0)::BIGINT FROM files f WHERE f.user_id = u.id) as drive_storage_bytes,
            (SELECT COALESCE(SUM(octet_length(content_encrypted)), 0)::BIGINT FROM messages m WHERE m.sender_id = u.id) as chat_storage_bytes,
            (SELECT COALESCE(SUM(octet_length(coalesce(content_encrypted, content, ''))), 0)::BIGINT FROM notes n WHERE n.user_id = u.id) as notes_storage_bytes
        FROM users u 
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await;

    match result {
        Ok(Some(row)) => {
            let id: i32 = row.get("id");
            let email: String = row.get("email");
            let first_name: Option<String> = row.try_get("first_name").ok();
            let last_name: Option<String> = row.try_get("last_name").ok();
            let auth_provider: String = row
                .try_get("auth_provider")
                .unwrap_or_else(|_| "local".to_string());
            let account_type: String = row
                .try_get("account_type")
                .unwrap_or_else(|_| "personal".to_string());
            let total_emails: i64 = row.get("total_emails");
            let email_storage_bytes: i64 = row.get("email_storage_bytes");
            let drive_storage_bytes: i64 = row.get("drive_storage_bytes");
            let chat_storage_bytes: i64 = row.get("chat_storage_bytes");
            let notes_storage_bytes: i64 = row.get("notes_storage_bytes");
            let username: Option<String> = row.try_get("username").ok();
            let recovery_mode: String = row
                .try_get("recovery_mode")
                .unwrap_or_else(|_| "full".to_string());
            let total_used = email_storage_bytes
                + drive_storage_bytes
                + chat_storage_bytes
                + notes_storage_bytes;

            let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
            let organization_name = display_organization_name(
                &account_type,
                &email,
                row.try_get("organization_name").ok().flatten(),
            );
            let access = match effective_access_for_user(pool.get_ref(), id).await {
                Ok(value) => value,
                Err(e) => {
                    error!(target: "db", user_id = id, error = ?e, "effective access lookup failed");
                    fallback_access(&account_type)
                }
            };

            // Same lookup as /api/me — falls back to basic_user when no
            // subscription exists. /api/profile is heavier than /api/me but
            // both pages want the tier badge, so we include it in both.
            let current_plan =
                match current_plan_for_user(pool.get_ref(), id, organization_id).await {
                    Ok(plan) => Some(plan),
                    Err(e) => {
                        warn!(target: "db", user_id = id, error = ?e, "current_plan lookup failed");
                        None
                    }
                };

            let response = serde_json::json!({
                "id": id,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "auth_provider": auth_provider,
                "account_type": account_type,
                "effective_role": access.role,
                "role_label": access.role_label,
                "scope": access.scope,
                "permissions": access.permissions,
                "organization_id": organization_id,
                "organization_name": organization_name,
                "current_plan": current_plan,
                "username": username,
                "total_emails": total_emails,
                "email_storage_bytes": email_storage_bytes,
                "drive_storage_bytes": drive_storage_bytes,
                "other_storage_bytes": chat_storage_bytes + notes_storage_bytes,
                "memory_used_bytes": total_used,
                "memory_limit_bytes": 10_737_418_240_i64, // 10 GB limit
                "recovery_mode": recovery_mode,
            });

            PROFILE_CACHE.insert(user_id, response.clone()).await;
            Ok(HttpResponse::Ok().json(response))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(AppError::Db(e)),
    }
}

#[post("/profile/password")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn change_password(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ChangePasswordInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if data.new_password.len() < 6 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "New password must be at least 6 characters" })));
    }

    let row = sqlx::query("SELECT password, auth_provider FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await;

    let (stored, auth_provider): (Option<String>, String) = match row {
        Ok(Some(r)) => (
            r.try_get("password").ok().flatten(),
            r.try_get("auth_provider")
                .unwrap_or_else(|_| "local".to_string()),
        ),
        _ => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if let Some(stored) = stored {
        let current_password = data.current_password.as_deref().unwrap_or("");
        let valid = verify_password(current_password, &stored)
            .await
            .unwrap_or(false);
        if !valid {
            warn!(target: "auth", user_id, "change-password: wrong current password");
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Current password is incorrect" })));
        }
    } else if auth_provider != "google" {
        warn!(target: "auth", user_id, "change-password rejected: missing password");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "This account has no password to change" })));
    }

    let hashed = hash_password(&data.new_password).await?;

    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(&hashed)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    info!(target: "auth", user_id, had_password = data.current_password.is_some(), "password updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Password updated" })))
}

#[put("/profile")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn update_profile(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ProfileUpdate>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let result = sqlx::query(
        "UPDATE users
         SET first_name = COALESCE($1, first_name),
             last_name = COALESCE($2, last_name)
         WHERE id = $3
         RETURNING id, email, first_name, last_name",
    )
    .bind(data.first_name.as_deref())
    .bind(data.last_name.as_deref())
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await;

    match result {
        Ok(Some(row)) => {
            invalidate_me_cache(user_id).await;
            invalidate_profile_cache(user_id).await;
            let id: i32 = row.get("id");
            let email: String = row.get("email");
            let first_name: Option<String> = row.try_get("first_name").ok();
            let last_name: Option<String> = row.try_get("last_name").ok();

            info!(target: "http", user_id, "profile updated");
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "id": id,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
            })))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(AppError::Db(e)),
    }
}

#[get("/users/all")]
#[instrument(target = "http", skip(req, pool))]
async fn get_all_users(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    // Require a valid JWT — this endpoint enumerates accounts.
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    // Scope the directory to the caller's own world so the chat people-picker
    // never leaks accounts across tenants: a platform account sees only
    // platform accounts, an organization account sees only same-org accounts,
    // and a personal account sees only other personal accounts.
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, email, public_key
        FROM users u
        WHERE (
            ($1 = 'personal'     AND u.account_type = 'personal')
         OR ($1 = 'platform'     AND u.account_type = 'platform_admin')
         OR ($1 = 'organization' AND u.account_type IN ('organization', 'organization_admin')
                                  AND u.organization_id = $2)
        )
        "#,
    )
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .fetch_all(pool.get_ref())
    .await?;

    let users: Vec<_> = rows
        .into_iter()
        .map(|r| {
            let id: i32 = r.get("id");
            let email: String = r.get("email");
            let public_key: Option<String> = r.get("public_key");
            let public_key = public_key.and_then(|k| serde_json::from_str::<Vec<u8>>(&k).ok());

            serde_json::json!({
                "id": id,
                "email": email,
                "public_key": public_key
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(users))
}

// ============================================================
// 🔐 RBAC — member listing & role management
// ============================================================

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
    info!(
        target: "auth",
        actor = ctx.user_id, organization_id, target_user_id,
        role = new_role.as_str(),
        "organization member role updated"
    );

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
    info!(
        target: "auth",
        actor = ctx.user_id, target_user_id,
        role = new_role.as_str(),
        "platform member role updated"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user_id": target_user_id,
        "role": new_role.as_str(),
        "role_label": role_label(new_role.as_str(), "platform_admin"),
    })))
}

#[cfg(test)]
mod auth_regression_tests {
    use super::*;

    #[test]
    fn test_normalized_account_type() {
        assert_eq!(normalized_account_type("personal"), "personal");
        assert_eq!(normalized_account_type("organization"), "organization");
        assert_eq!(
            normalized_account_type("organization_admin"),
            "organization_admin"
        );
        assert_eq!(normalized_account_type("platform_admin"), "platform_admin");
        assert_eq!(normalized_account_type("unknown"), "personal");
    }

    #[test]
    fn test_display_organization_name() {
        assert_eq!(
            display_organization_name("personal", "user@example.com", None),
            Some("user@example.com".to_string())
        );
        assert_eq!(
            display_organization_name(
                "organization",
                "member@example.com",
                Some("Example Org".to_string())
            ),
            Some("Example Org".to_string())
        );
        assert_eq!(
            display_organization_name("platform_admin", "admin@example.com", None),
            None
        );
    }

    #[actix_web::test]
    async fn test_api_key_generation_and_validation() {
        use crate::test_support::test_pool;
        let pool = test_pool().await;

        // 1. Setup: Create an organization with a UUID-suffixed name so
        // repeated test runs don't trip the orgs.name UNIQUE constraint.
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        )
        .bind(format!("Test Org {unique}"))
        .fetch_one(&pool)
        .await
        .unwrap();

        // 2. Generate Key. raw_key must also be UUID-tagged so the
        // api_keys.key_hash UNIQUE constraint doesn't reject re-runs.
        let raw_key = format!("wv_sk_test_secret_{unique}");
        let key_hash = hash_api_key(&raw_key);

        sqlx::query("INSERT INTO api_keys (organization_id, name, key_hash, key_preview) VALUES ($1, $2, $3, $4)")
            .bind(org_id)
            .bind("Test Key")
            .bind(&key_hash)
            .bind(format!("wv_sk_..._{unique}"))
            .execute(&pool)
            .await
            .unwrap();

        // 3. Test Validation Helper
        let req = actix_test::TestRequest::default()
            .insert_header(("X-API-KEY", raw_key.as_str()))
            .to_http_request();

        let validated_org_id = validate_api_key(&req, &pool).await;
        assert_eq!(validated_org_id, Some(org_id));

        // 4. Test Validation with wrong key
        let req_bad = actix_test::TestRequest::default()
            .insert_header(("X-API-KEY", "wrong_key"))
            .to_http_request();

        let validated_bad = validate_api_key(&req_bad, &pool).await;
        assert!(validated_bad.is_none());
    }

    // Import the actix test module under an alias — a bare `test` import
    // shadows the built-in `#[test]` attribute (it would resolve to
    // `#[actix_web::test]` and reject the sync unit test above).
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::postgres::PgPoolOptions;

    fn lazy_pool() -> PgPool {
        PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@localhost/rwayve_test")
            .expect("lazy pool")
    }

    #[actix_web::test]
    async fn get_user_by_email_requires_auth() {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(get_user_by_email),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/users?email=target@example.com")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn get_all_users_requires_auth() {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(get_all_users),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/users/all")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn update_organization_member_role_authorization() {
        use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
        let pool = test_pool().await;

        // An organization with an owner, a plain member, and a target member.
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("RBAC Org {}", random_email()))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("create org: {e}"));

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "password123").await;
        let target_email = random_email();
        let target_id = insert_local_user(&pool, &target_email, "password123").await;

        for (uid, role) in [
            (owner_id, "owner"),
            (member_id, "member"),
            (target_id, "member"),
        ] {
            sqlx::query(
                "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
            )
            .bind(org_id)
            .bind(uid)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("attach user to org: {e}"));
            sqlx::query(
                "INSERT INTO organization_members (organization_id, user_id, role) \
                 VALUES ($1, $2, $3)",
            )
            .bind(org_id)
            .bind(uid)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("insert membership: {e}"));
        }

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_organization_member_role),
        )
        .await;

        let put = |actor_id: i32, actor_email: &str, uid: i32, role: &str| {
            actix_test::TestRequest::put()
                .uri(&format!("/organizations/{org_id}/members/{uid}/role"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(actor_id, actor_email)),
                ))
                .set_json(serde_json::json!({ "role": role }))
                .to_request()
        };

        // Owner holds roles:manage — may demote the target member.
        let resp =
            actix_test::call_service(&app, put(owner_id, &owner_email, target_id, "developer"))
                .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // A plain member has no role-management permission — 403.
        let resp =
            actix_test::call_service(&app, put(member_id, &member_email, target_id, "support"))
                .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // The sole owner cannot demote themselves — 409.
        let resp =
            actix_test::call_service(&app, put(owner_id, &owner_email, owner_id, "member")).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        for uid in [owner_id, member_id, target_id] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await;
    }
}
