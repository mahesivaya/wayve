//! Developer-app registration — the developer-platform "front door".
//!
//! A registered third-party integration gets a public `client_id` and a
//! `client_secret` (shown once, only its SHA-256 hash stored — exactly like
//! api_keys). `redirect_uris` + `scopes` are captured here so the future OAuth
//! authorize/token flow can consume them without a schema change.
//!
//! All endpoints are gated by the RBAC `api_keys:manage` permission (developer
//! apps are credential management, same trust boundary as API keys) plus an
//! owner-scope check mirroring `routes::api_keys`.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, delete, get, patch, post, web};
use chrono::{DateTime, Utc};
use tracing::{info, instrument};
use wayve_security::api_key::{
    generate_client_id, generate_client_secret, hash_api_key, is_valid_scope,
};
use wayve_security::rbac::{self, Permission, RoleContext, Scope};

const MAX_REDIRECT_URIS: usize = 10;
const URI_MAX_LEN: usize = 2000;

#[derive(Deserialize)]
pub struct CreateAppInput {
    pub name: String,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// PATCH body — every field optional; only those present are changed.
#[derive(Deserialize)]
pub struct UpdateAppInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    pub redirect_uris: Option<Vec<String>>,
    pub scopes: Option<Vec<String>>,
}

/// A registered app as exposed to the UI. `client_id` is public; the secret is
/// never returned after creation/rotation, only its redacted preview.
#[derive(Serialize, FromRow)]
pub struct DeveloperAppView {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    pub client_id: String,
    pub client_secret_preview: String,
    pub redirect_uris: Vec<String>,
    pub scopes: Vec<String>,
    pub user_id: i32,
    pub organization_id: Option<i32>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const APP_COLUMNS: &str = "id, name, description, homepage_url, client_id, \
     client_secret_preview, redirect_uris, scopes, user_id, organization_id, \
     revoked_at, created_at, updated_at";

/// Validate the requested scopes: each must be a known scope, and third-party
/// apps may never hold the full-access `*` (that is internal-key only).
fn validate_scopes(scopes: &[String]) -> Result<(), String> {
    for scope in scopes {
        if scope == "*" {
            return Err("Apps may not request the '*' scope".to_string());
        }
        if !is_valid_scope(scope) {
            return Err(format!("Unknown scope: {scope}"));
        }
    }
    Ok(())
}

/// Validate an OAuth redirect URI: an absolute `http`/`https` URL, length-capped.
/// `http` is allowed only for loopback (local development).
fn validate_redirect_uri(raw: &str) -> Result<(), String> {
    if raw.len() > URI_MAX_LEN {
        return Err("Redirect URI is too long".to_string());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| format!("Invalid redirect URI: {raw}"))?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => Ok(()),
        _ => Err(format!(
            "Redirect URI must be https (or http on localhost): {raw}"
        )),
    }
}

fn validate_redirect_uris(uris: &[String]) -> Result<(), String> {
    if uris.len() > MAX_REDIRECT_URIS {
        return Err(format!(
            "At most {MAX_REDIRECT_URIS} redirect URIs are allowed"
        ));
    }
    for uri in uris {
        validate_redirect_uri(uri)?;
    }
    Ok(())
}

/// Normalize an optional homepage URL: trims, treats empty as absent, and
/// requires an `http`/`https` scheme when present.
fn normalize_homepage(raw: Option<&str>) -> Result<Option<String>, String> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => {
            let url = reqwest::Url::parse(s).map_err(|_| "Invalid homepage URL".to_string())?;
            if matches!(url.scheme(), "http" | "https") {
                Ok(Some(s.to_string()))
            } else {
                Err("Homepage URL must be http or https".to_string())
            }
        }
    }
}

/// Whether `app_id` is one the caller may see/manage — same three-way rule as
/// api_keys: platform staff see every app; an org manager sees apps whose owner
/// is in their org or that they created; otherwise only the caller's own apps.
async fn app_in_caller_scope(
    pool: &PgPool,
    ctx: &RoleContext,
    app_id: i32,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT da.created_by, da.user_id, u.organization_id AS owner_org
        FROM developer_apps da
        LEFT JOIN users u ON u.id = da.user_id
        WHERE da.id = $1
        "#,
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(false);
    };
    let created_by: Option<i32> = row.try_get("created_by").ok().flatten();
    let user_id: Option<i32> = row.try_get("user_id").ok().flatten();
    let owner_org: Option<i32> = row.try_get("owner_org").ok().flatten();

    Ok(match ctx.scope {
        Scope::Platform => true,
        Scope::Organization => owner_org == ctx.organization_id || created_by == Some(ctx.user_id),
        Scope::Personal => created_by == Some(ctx.user_id) || user_id == Some(ctx.user_id),
    })
}

fn bad_request(message: String) -> HttpResponse {
    HttpResponse::BadRequest().json(serde_json::json!({ "message": message }))
}

#[post("/developer/apps")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn create_app(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateAppInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let name = data.name.trim();
    if name.is_empty() {
        return Ok(bad_request("App name is required".to_string()));
    }
    if let Err(msg) = validate_scopes(&data.scopes) {
        return Ok(bad_request(msg));
    }
    if let Err(msg) = validate_redirect_uris(&data.redirect_uris) {
        return Ok(bad_request(msg));
    }
    let homepage = match normalize_homepage(data.homepage_url.as_deref()) {
        Ok(h) => h,
        Err(msg) => return Ok(bad_request(msg)),
    };
    let description = data
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // The secret is returned exactly once; only its hash persists.
    let client_id = generate_client_id();
    let client_secret = generate_client_secret();
    let secret_hash = hash_api_key(&client_secret);
    let secret_preview = format!(
        "{}...{}",
        &client_secret[..9],
        &client_secret[client_secret.len() - 4..]
    );

    let row = sqlx::query(
        r#"
        INSERT INTO developer_apps
            (user_id, organization_id, created_by, name, description, homepage_url,
             client_id, client_secret_hash, client_secret_preview, redirect_uris, scopes)
        VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, created_at, updated_at
        "#,
    )
    .bind(ctx.user_id)
    .bind(ctx.organization_id)
    .bind(name)
    .bind(&description)
    .bind(&homepage)
    .bind(&client_id)
    .bind(&secret_hash)
    .bind(&secret_preview)
    .bind(&data.redirect_uris)
    .bind(&data.scopes)
    .fetch_one(pool.get_ref())
    .await?;

    let id: i32 = row.get("id");
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");
    info!(target: "auth", actor = ctx.user_id, app_id = id, %client_id, "developer app created");

    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "homepage_url": homepage,
        "client_id": client_id,
        "client_secret_preview": secret_preview,
        "redirect_uris": data.redirect_uris,
        "scopes": data.scopes,
        "user_id": ctx.user_id,
        "organization_id": ctx.organization_id,
        "revoked_at": Option::<DateTime<Utc>>::None,
        "created_at": created_at,
        "updated_at": updated_at,
        // The client secret exists in this response only — never re-fetchable.
        "client_secret": client_secret,
    })))
}

#[get("/developer/apps")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_apps(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let rows = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, DeveloperAppView>(&format!(
                "SELECT {APP_COLUMNS} FROM developer_apps ORDER BY created_at DESC"
            ))
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Organization => {
            sqlx::query_as::<_, DeveloperAppView>(&format!(
                "SELECT {APP_COLUMNS} FROM developer_apps
                 WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)
                    OR created_by = $2
                 ORDER BY created_at DESC"
            ))
            .bind(ctx.organization_id)
            .bind(ctx.user_id)
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Personal => {
            sqlx::query_as::<_, DeveloperAppView>(&format!(
                "SELECT {APP_COLUMNS} FROM developer_apps
                 WHERE created_by = $1 OR user_id = $1
                 ORDER BY created_at DESC"
            ))
            .bind(ctx.user_id)
            .fetch_all(pool.get_ref())
            .await
        }
    }?;

    Ok(HttpResponse::Ok().json(rows))
}

#[patch("/developer/apps/{id}")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn update_app(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<UpdateAppInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let app_id = path.into_inner();
    if !app_in_caller_scope(pool.get_ref(), &ctx, app_id).await? {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "App not found" })));
    }

    // Load current values, then apply only the fields the caller supplied.
    let Some(current) = sqlx::query_as::<_, DeveloperAppView>(&format!(
        "SELECT {APP_COLUMNS} FROM developer_apps WHERE id = $1"
    ))
    .bind(app_id)
    .fetch_optional(pool.get_ref())
    .await?
    else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "App not found" })));
    };

    let name = match data.name.as_deref().map(str::trim) {
        Some("") => return Ok(bad_request("App name cannot be empty".to_string())),
        Some(n) => n.to_string(),
        None => current.name.clone(),
    };
    let scopes = match &data.scopes {
        Some(s) => {
            if let Err(msg) = validate_scopes(s) {
                return Ok(bad_request(msg));
            }
            s.clone()
        }
        None => current.scopes.clone(),
    };
    let redirect_uris = match &data.redirect_uris {
        Some(u) => {
            if let Err(msg) = validate_redirect_uris(u) {
                return Ok(bad_request(msg));
            }
            u.clone()
        }
        None => current.redirect_uris.clone(),
    };
    // `description`/`homepage_url` present in the body replace the value ("" clears).
    let description = match &data.description {
        Some(d) => Some(d.trim().to_string()).filter(|s| !s.is_empty()),
        None => current.description.clone(),
    };
    let homepage_url = match data.homepage_url.as_deref() {
        Some(h) => match normalize_homepage(Some(h)) {
            Ok(v) => v,
            Err(msg) => return Ok(bad_request(msg)),
        },
        None => current.homepage_url.clone(),
    };

    let updated = sqlx::query_as::<_, DeveloperAppView>(&format!(
        "UPDATE developer_apps
            SET name = $2, description = $3, homepage_url = $4,
                redirect_uris = $5, scopes = $6, updated_at = NOW()
          WHERE id = $1
        RETURNING {APP_COLUMNS}"
    ))
    .bind(app_id)
    .bind(&name)
    .bind(&description)
    .bind(&homepage_url)
    .bind(&redirect_uris)
    .bind(&scopes)
    .fetch_one(pool.get_ref())
    .await?;

    info!(target: "auth", actor = ctx.user_id, app_id, "developer app updated");
    Ok(HttpResponse::Ok().json(updated))
}

#[post("/developer/apps/{id}/rotate-secret")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn rotate_secret(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let app_id = path.into_inner();
    if !app_in_caller_scope(pool.get_ref(), &ctx, app_id).await? {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "App not found" })));
    }

    let client_secret = generate_client_secret();
    let secret_hash = hash_api_key(&client_secret);
    let secret_preview = format!(
        "{}...{}",
        &client_secret[..9],
        &client_secret[client_secret.len() - 4..]
    );

    let result = sqlx::query(
        "UPDATE developer_apps
            SET client_secret_hash = $2, client_secret_preview = $3, updated_at = NOW()
          WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(app_id)
    .bind(&secret_hash)
    .bind(&secret_preview)
    .execute(pool.get_ref())
    .await?;

    if result.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "App not found or revoked" })));
    }

    info!(target: "auth", actor = ctx.user_id, app_id, "developer app secret rotated");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": app_id,
        "client_secret_preview": secret_preview,
        "client_secret": client_secret,
    })))
}

#[delete("/developer/apps/{id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn revoke_app(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let app_id = path.into_inner();
    if !app_in_caller_scope(pool.get_ref(), &ctx, app_id).await? {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "App not found" })));
    }

    // Soft-revoke (mirrors api_keys) so the id stays valid for any tokens the
    // future OAuth flow will mint against it.
    let result = sqlx::query(
        "UPDATE developer_apps SET revoked_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(app_id)
    .execute(pool.get_ref())
    .await?;

    if result.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "App not found or already revoked" })));
    }

    info!(target: "auth", actor = ctx.user_id, app_id, "developer app revoked");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "revoked": true })))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(create_app)
        .service(list_apps)
        .service(update_app)
        .service(rotate_secret)
        .service(revoke_app);
}
