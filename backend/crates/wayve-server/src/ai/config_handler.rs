//! AI provider configuration: the provider, model, and key the org's assistant
//! runs on. Restricted to owners on the enterprise tier (see `require_ai_owner`);
//! admins and super_admins are rejected. The key is validated with a live probe
//! before storing, encrypted at rest, and never returned to the browser. Custom
//! `base_url`s are SSRF-guarded via the MCP guard.

use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Role, Scope, resolve_role_context_moded};

use crate::ai::provider::{AiProvider, ResolvedAi};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_config)
        .service(put_config)
        .service(delete_config)
        .service(get_data_access)
        .service(put_data_access);
}

/// Who owns an AI provider config. Each variant maps to a different storage row
/// (`org_ai_configs` vs the `platform_ai_config` singleton) and a different
/// audience; the platform config never affects org resolution.
#[derive(Clone, Copy)]
pub(crate) enum AiOwner {
    Org(i32),
    Platform,
}

impl AiOwner {
    fn audit_resource_type(self) -> &'static str {
        match self {
            AiOwner::Org(_) => "org_ai_config",
            AiOwner::Platform => "platform_ai_config",
        }
    }
    fn audit_resource_id(self) -> String {
        match self {
            AiOwner::Org(id) => id.to_string(),
            AiOwner::Platform => "platform".to_string(),
        }
    }
}

/// Resolve the caller as an AI-config owner, or `Forbidden`. `Role::Owner` only,
/// never super_admin or admin. An organization owner must additionally be on the
/// enterprise tier; personal owners have no scope to configure and are rejected.
pub(crate) async fn require_ai_owner(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<AiOwner, AppError> {
    let ctx = resolve_role_context_moded(req, pool, user_id)
        .await
        .map_err(AppError::from)?;
    if ctx.role != Role::Owner {
        return Err(AppError::Forbidden);
    }
    match ctx.scope {
        Scope::Organization => {
            let org_id = ctx.organization_id.ok_or(AppError::Forbidden)?;
            if is_enterprise_org(pool, org_id).await? {
                Ok(AiOwner::Org(org_id))
            } else {
                Err(AppError::Forbidden)
            }
        }
        Scope::Platform => Ok(AiOwner::Platform),
        Scope::Personal => Err(AppError::Forbidden),
    }
}

/// Read the projected config row for `owner`. Both tables project the same
/// columns.
async fn load_config_row(
    pool: &PgPool,
    owner: AiOwner,
) -> sqlx::Result<Option<sqlx::postgres::PgRow>> {
    const COLS: &str =
        "provider, base_url, model, api_key_encrypted, fail_closed, enabled, last_validated_at";
    match owner {
        AiOwner::Org(org_id) => {
            sqlx::query(&format!(
                "SELECT {COLS} FROM org_ai_configs WHERE organization_id = $1"
            ))
            .bind(org_id)
            .fetch_optional(pool)
            .await
        }
        AiOwner::Platform => {
            sqlx::query(&format!(
                "SELECT {COLS} FROM platform_ai_config WHERE id = 1"
            ))
            .fetch_optional(pool)
            .await
        }
    }
}

/// Read the stored `(iv, encrypted)` key pair so an omitted key is preserved.
async fn load_key_pair(
    pool: &PgPool,
    owner: AiOwner,
) -> sqlx::Result<(Option<String>, Option<String>)> {
    let row = match owner {
        AiOwner::Org(org_id) => sqlx::query(
            "SELECT api_key_iv, api_key_encrypted FROM org_ai_configs WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_optional(pool)
        .await?,
        AiOwner::Platform => {
            sqlx::query("SELECT api_key_iv, api_key_encrypted FROM platform_ai_config WHERE id = 1")
                .fetch_optional(pool)
                .await?
        }
    };
    Ok((
        row.as_ref()
            .and_then(|r| r.try_get("api_key_iv").ok().flatten()),
        row.as_ref()
            .and_then(|r| r.try_get("api_key_encrypted").ok().flatten()),
    ))
}

/// Upsert the config for `owner`.
#[allow(clippy::too_many_arguments)]
async fn upsert_config(
    pool: &PgPool,
    owner: AiOwner,
    provider: AiProvider,
    base_url: &Option<String>,
    model: &Option<String>,
    store_iv: &Option<String>,
    store_enc: &Option<String>,
    fail_closed: bool,
    user_id: i32,
) -> sqlx::Result<()> {
    match owner {
        AiOwner::Org(org_id) => {
            sqlx::query(
                "INSERT INTO org_ai_configs
                    (organization_id, provider, base_url, model, api_key_iv, api_key_encrypted,
                     fail_closed, enabled, last_validated_at, connected_by, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW(), $8, NOW())
                 ON CONFLICT (organization_id) DO UPDATE SET
                    provider = EXCLUDED.provider, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
                    api_key_iv = EXCLUDED.api_key_iv, api_key_encrypted = EXCLUDED.api_key_encrypted,
                    fail_closed = EXCLUDED.fail_closed, enabled = TRUE, last_validated_at = NOW(),
                    connected_by = EXCLUDED.connected_by, updated_at = NOW()",
            )
            .bind(org_id)
            .bind(provider.as_str())
            .bind(base_url)
            .bind(model)
            .bind(store_iv)
            .bind(store_enc)
            .bind(fail_closed)
            .bind(user_id)
            .execute(pool)
            .await
            .map(|_| ())
        }
        AiOwner::Platform => {
            sqlx::query(
                "INSERT INTO platform_ai_config
                    (id, provider, base_url, model, api_key_iv, api_key_encrypted,
                     fail_closed, enabled, last_validated_at, connected_by, updated_at)
                 VALUES (1, $1, $2, $3, $4, $5, $6, TRUE, NOW(), $7, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                    provider = EXCLUDED.provider, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
                    api_key_iv = EXCLUDED.api_key_iv, api_key_encrypted = EXCLUDED.api_key_encrypted,
                    fail_closed = EXCLUDED.fail_closed, enabled = TRUE, last_validated_at = NOW(),
                    connected_by = EXCLUDED.connected_by, updated_at = NOW()",
            )
            .bind(provider.as_str())
            .bind(base_url)
            .bind(model)
            .bind(store_iv)
            .bind(store_enc)
            .bind(fail_closed)
            .bind(user_id)
            .execute(pool)
            .await
            .map(|_| ())
        }
    }
}

/// Delete the config for `owner`, resetting it to the built-in default.
async fn delete_config_row(pool: &PgPool, owner: AiOwner) -> sqlx::Result<()> {
    match owner {
        AiOwner::Org(org_id) => {
            sqlx::query("DELETE FROM org_ai_configs WHERE organization_id = $1")
                .bind(org_id)
                .execute(pool)
                .await
                .map(|_| ())
        }
        AiOwner::Platform => sqlx::query("DELETE FROM platform_ai_config WHERE id = 1")
            .execute(pool)
            .await
            .map(|_| ()),
    }
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

/// What the owner can pick. Surfaced so the settings page need not hardcode the
/// catalog.
fn provider_catalog() -> Value {
    serde_json::json!([
        { "id": "anthropic", "label": "Claude", "vendor": "Anthropic",
          "default_model": AiProvider::Anthropic.default_model(), "needs_base_url": false },
        { "id": "gemini", "label": "Gemini", "vendor": "Google",
          "default_model": AiProvider::Gemini.default_model(), "needs_base_url": false },
        { "id": "openai_compatible", "label": "OpenAI-compatible", "vendor": "Azure / Bedrock / gateway",
          "default_model": AiProvider::OpenAiCompatible.default_model(), "needs_base_url": true },
    ])
}

#[derive(Deserialize)]
pub struct AiConfigInput {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// New API key. Omitted = keep current; "" = clear (Gemini → platform key).
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_true")]
    pub fail_closed: bool,
}

fn default_true() -> bool {
    true
}

#[get("/ai/config")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_config(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

    let row = load_config_row(pool.get_ref(), owner).await?;

    let config = match row {
        Some(r) => serde_json::json!({
            "configured": true,
            "provider": r.get::<String, _>("provider"),
            "base_url": r.try_get::<Option<String>, _>("base_url").ok().flatten(),
            "model": r.try_get::<Option<String>, _>("model").ok().flatten(),
            "fail_closed": r.try_get::<bool, _>("fail_closed").unwrap_or(true),
            "enabled": r.try_get::<bool, _>("enabled").unwrap_or(true),
            "has_key": r.try_get::<Option<String>, _>("api_key_encrypted").ok().flatten().is_some(),
            "last_validated_at": r.try_get::<Option<NaiveDateTime>, _>("last_validated_at").ok().flatten(),
        }),
        None => serde_json::json!({
            "configured": false,
            "provider": Value::Null,
            "base_url": Value::Null,
            "model": Value::Null,
            "fail_closed": true,
            "enabled": false,
            "has_key": false,
            "last_validated_at": Value::Null,
        }),
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "config": config,
        "providers": provider_catalog(),
    })))
}

#[put("/ai/config")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<AiConfigInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

    let provider = AiProvider::parse(body.provider.trim())
        .ok_or_else(|| AppError::bad_request("Unknown AI provider"))?;
    let base_url = body
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let model = body
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if provider == AiProvider::OpenAiCompatible && base_url.is_none() {
        return Err(AppError::bad_request(
            "A base URL is required for an OpenAI-compatible provider",
        ));
    }
    // Any custom endpoint must clear the MCP SSRF guard: https, public IP.
    if let Some(b) = &base_url {
        crate::integrations::mcp::client::validate_server_url(b)
            .await
            .map_err(|_| AppError::bad_request("Base URL must be a public https endpoint"))?;
    }

    let (cur_iv, cur_enc) = load_key_pair(pool.get_ref(), owner).await?;

    // An omitted api_key keeps the current one; an empty string clears it, which
    // drops Gemini back to the platform key; anything else replaces it.
    let (store_iv, store_enc, effective_key): (Option<String>, Option<String>, Option<String>) =
        match body.api_key.as_deref() {
            Some(k) if k.trim().is_empty() => (None, None, None),
            Some(k) => {
                let (iv, enc) = encrypt(k.trim()).map_err(|e| {
                    warn!(target: "worker", error = %e, "ai key encrypt failed");
                    AppError::Internal("Failed to store AI credentials".into())
                })?;
                (Some(iv), Some(enc), Some(k.trim().to_string()))
            }
            None => {
                let eff = match (&cur_iv, &cur_enc) {
                    (Some(iv), Some(enc)) => Some(decrypt(iv, enc).map_err(|e| {
                        warn!(target: "worker", error = %e, "ai key decrypt failed");
                        AppError::Internal("Failed to read AI credentials".into())
                    })?),
                    _ => None,
                };
                (cur_iv.clone(), cur_enc.clone(), eff)
            }
        };

    // Every provider but Gemini must carry its own key.
    let validate_key = match effective_key {
        Some(k) => k,
        None if provider.requires_key() => {
            return Err(AppError::bad_request(
                "An API key is required for this provider",
            ));
        }
        None => crate::config::gemini_api_key().ok_or_else(|| {
            AppError::bad_request("No platform Gemini key configured; provide an API key")
        })?,
    };

    let model_eff = model
        .clone()
        .unwrap_or_else(|| provider.default_model().to_string());

    // A live probe before storing means a bad key, model, or endpoint 400s here
    // rather than at chat time.
    let probe_ai = ResolvedAi {
        provider,
        api_key: validate_key,
        model: model_eff.clone(),
        base_url: base_url.clone(),
        fail_closed: true,
        data_access: crate::ai::provider::DataAccess::default(),
    };
    crate::ai::agent::probe(&probe_ai).await.map_err(|e| {
        warn!(target: "ai", error = %e, "ai provider validation failed");
        AppError::bad_request(
            "Could not reach the AI provider with these settings — check the key, model, and endpoint",
        )
    })?;

    upsert_config(
        pool.get_ref(),
        owner,
        provider,
        &base_url,
        &model,
        &store_iv,
        &store_enc,
        body.fail_closed,
        user_id,
    )
    .await?;

    let owner_label = owner.audit_resource_id();
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "ai_provider.update",
            resource_type: owner.audit_resource_type(),
            resource_id: Some(owner_label.clone()),
            metadata: Some(serde_json::json!({
                "provider": provider.as_str(),
                "model": model_eff,
                "fail_closed": body.fail_closed,
            })),
        },
    )
    .await;

    info!(target: "worker", user_id, owner = %owner_label, provider = provider.as_str(), "ai provider configured");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "configured": true,
        "provider": provider.as_str(),
        "base_url": base_url,
        "model": model_eff,
        "fail_closed": body.fail_closed,
        "enabled": true,
        "has_key": store_enc.is_some(),
    })))
}

#[delete("/ai/config")]
#[instrument(target = "http", skip(req, pool))]
pub async fn delete_config(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

    delete_config_row(pool.get_ref(), owner).await?;

    let owner_label = owner.audit_resource_id();
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "ai_provider.delete",
            resource_type: owner.audit_resource_type(),
            resource_id: Some(owner_label.clone()),
            metadata: None,
        },
    )
    .await;

    info!(target: "worker", user_id, owner = %owner_label, "ai provider reset to default");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "configured": false })))
}

// AI data access: which categories of the user's own Wayve data the platform
// assistant's native tools may touch. Platform-owner only, stored on the
// `platform_ai_config` singleton and enforced in `native_tools` and `agent`. Org
// and personal callers are never gated.

#[derive(serde::Deserialize)]
struct DataAccessPayload {
    email: bool,
    calendar: bool,
}

/// Require the caller to be the platform owner, not an org owner.
pub(crate) async fn require_platform_owner(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<(), AppError> {
    match require_ai_owner(req, pool, user_id).await? {
        AiOwner::Platform => Ok(()),
        AiOwner::Org(_) => Err(AppError::Forbidden),
    }
}

#[get("/ai/data-access")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_data_access(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    require_platform_owner(&req, pool.get_ref(), user_id).await?;

    let row = sqlx::query(
        "SELECT ai_allow_email, ai_allow_calendar FROM platform_ai_config WHERE id = 1",
    )
    .fetch_optional(pool.get_ref())
    .await?;
    // With no configured provider, everything is open by default.
    let (email, calendar) = match row {
        Some(r) => (
            r.try_get::<bool, _>("ai_allow_email").unwrap_or(true),
            r.try_get::<bool, _>("ai_allow_calendar").unwrap_or(true),
        ),
        None => (true, true),
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "email": email,
        "calendar": calendar,
    })))
}

#[put("/ai/data-access")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_data_access(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<DataAccessPayload>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    require_platform_owner(&req, pool.get_ref(), user_id).await?;

    // UPDATE only: the row is created by the provider config flow, and the toggles
    // mean nothing without a configured platform provider.
    let res = sqlx::query(
        "UPDATE platform_ai_config
            SET ai_allow_email = $1, ai_allow_calendar = $2, updated_at = NOW()
          WHERE id = 1",
    )
    .bind(body.email)
    .bind(body.calendar)
    .execute(pool.get_ref())
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::bad_request(
            "Configure the platform AI provider first, then set data access.",
        ));
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "ai_data_access.update",
            resource_type: "platform_ai_config",
            resource_id: Some("platform".to_string()),
            metadata: Some(serde_json::json!({
                "email": body.email,
                "calendar": body.calendar,
            })),
        },
    )
    .await;

    info!(target: "worker", user_id, email = body.email, calendar = body.calendar, "ai data access updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "email": body.email,
        "calendar": body.calendar,
    })))
}
