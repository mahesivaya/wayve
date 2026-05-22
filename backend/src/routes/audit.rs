use crate::prelude::*;
use crate::security::encryption::{decrypt, encrypt};
use crate::security::rbac::{self, Permission, Scope};
use actix_web::{HttpRequest, HttpResponse, get, post, put, web};
use chrono::{DateTime, Utc};
use std::time::Duration;
use tracing::{instrument, warn};

const AUDIT_LOG_DEFAULT_LIMIT: i64 = 100;
const AUDIT_LOG_MAX_LIMIT: i64 = 500;

#[derive(Deserialize)]
pub struct AuditLogQuery {
    pub limit: Option<i64>,
    pub outcome: Option<String>,
    pub api_key_id: Option<i32>,
    pub user_id: Option<i32>,
}

#[derive(Serialize, FromRow)]
pub struct AuditLogView {
    pub id: i64,
    pub api_key_id: Option<i32>,
    pub api_key_name: Option<String>,
    pub key_preview: Option<String>,
    pub user_id: Option<i32>,
    pub method: String,
    pub path: String,
    pub status_code: i32,
    pub outcome: String,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct SiemSettingsInput {
    pub webhook_url: String,
    pub webhook_token: Option<String>,
    pub enabled: bool,
}

#[derive(Serialize, FromRow)]
pub struct SiemSettingsView {
    pub scope: String,
    pub organization_id: Option<i32>,
    pub user_id: Option<i32>,
    pub webhook_url: String,
    pub token_configured: bool,
    pub enabled: bool,
    pub source: String,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct SiemSettingsRow {
    scope: String,
    organization_id: Option<i32>,
    user_id: Option<i32>,
    webhook_url: String,
    token_iv: Option<String>,
    token_encrypted: Option<String>,
    enabled: bool,
    updated_at: DateTime<Utc>,
}

impl SiemSettingsRow {
    fn into_view(self) -> SiemSettingsView {
        SiemSettingsView {
            scope: self.scope,
            organization_id: self.organization_id,
            user_id: self.user_id,
            webhook_url: self.webhook_url,
            token_configured: self
                .token_encrypted
                .as_deref()
                .is_some_and(|v| !v.is_empty()),
            enabled: self.enabled,
            source: "database".to_string(),
            updated_at: Some(self.updated_at),
        }
    }
}

#[get("/audit/logs")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_audit_logs(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AuditLogQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::AuditRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let limit = query
        .limit
        .unwrap_or(AUDIT_LOG_DEFAULT_LIMIT)
        .clamp(1, AUDIT_LOG_MAX_LIMIT);
    let outcome = query
        .outcome
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());

    let rows = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
                SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                       l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
                FROM api_key_audit_log l
                LEFT JOIN api_keys ak ON ak.id = l.api_key_id
                WHERE ($1::TEXT IS NULL OR l.outcome = $1)
                  AND ($2::INTEGER IS NULL OR l.api_key_id = $2)
                  AND ($3::INTEGER IS NULL OR l.user_id = $3)
                ORDER BY l.created_at DESC
                LIMIT $4
                "#,
            )
            .bind(outcome)
            .bind(query.api_key_id)
            .bind(query.user_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Organization => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
                SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                       l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
                FROM api_key_audit_log l
                LEFT JOIN api_keys ak ON ak.id = l.api_key_id
                WHERE ($1::TEXT IS NULL OR l.outcome = $1)
                  AND ($2::INTEGER IS NULL OR l.api_key_id = $2)
                  AND ($3::INTEGER IS NULL OR l.user_id = $3)
                  AND (
                    ak.user_id IN (SELECT id FROM users WHERE organization_id = $4)
                    OR l.user_id IN (SELECT id FROM users WHERE organization_id = $4)
                    OR ak.created_by = $5
                  )
                ORDER BY l.created_at DESC
                LIMIT $6
                "#,
            )
            .bind(outcome)
            .bind(query.api_key_id)
            .bind(query.user_id)
            .bind(ctx.organization_id)
            .bind(ctx.user_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Personal => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
                SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                       l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
                FROM api_key_audit_log l
                LEFT JOIN api_keys ak ON ak.id = l.api_key_id
                WHERE ($1::TEXT IS NULL OR l.outcome = $1)
                  AND ($2::INTEGER IS NULL OR l.api_key_id = $2)
                  AND ($3::INTEGER IS NULL OR l.user_id = $3)
                  AND (ak.created_by = $4 OR ak.user_id = $4 OR l.user_id = $4)
                ORDER BY l.created_at DESC
                LIMIT $5
                "#,
            )
            .bind(outcome)
            .bind(query.api_key_id)
            .bind(query.user_id)
            .bind(ctx.user_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await
        }
    }?;

    Ok(HttpResponse::Ok().json(rows))
}

#[get("/audit/siem-settings")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_siem_settings(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    if let Some(row) =
        load_siem_settings_for_scope(pool.get_ref(), ctx.scope, ctx.organization_id, ctx.user_id)
            .await?
    {
        return Ok(HttpResponse::Ok().json(row.into_view()));
    }

    let env = crate::config::siem();
    let webhook_url = env.webhook_url.unwrap_or_default();
    let env_enabled = !webhook_url.is_empty();
    Ok(HttpResponse::Ok().json(SiemSettingsView {
        scope: ctx.scope.as_str().to_string(),
        organization_id: scope_org_id(ctx.scope, ctx.organization_id),
        user_id: scope_user_id(ctx.scope, ctx.user_id),
        webhook_url,
        token_configured: env.webhook_token.is_some(),
        enabled: env_enabled,
        source: "environment".to_string(),
        updated_at: None,
    }))
}

#[put("/audit/siem-settings")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn upsert_siem_settings(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<SiemSettingsInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let webhook_url = body.webhook_url.trim();
    if body.enabled && webhook_url.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Webhook URL is required" })));
    }
    let scheme_ok = webhook_url.is_empty()
        || webhook_url.starts_with("https://")
        || webhook_url.starts_with("http://");
    if !scheme_ok {
        return Ok(HttpResponse::BadRequest().json(
            serde_json::json!({ "message": "Webhook URL must start with http:// or https://" }),
        ));
    }

    let existing =
        load_siem_settings_for_scope(pool.get_ref(), ctx.scope, ctx.organization_id, ctx.user_id)
            .await?;
    let (token_iv, token_encrypted) = match body.webhook_token.as_deref().map(str::trim) {
        Some("") => (None, None),
        Some(token) => {
            let (iv, encrypted) = encrypt(token)
                .map_err(|e| AppError::Internal(format!("SIEM token encrypt failed: {e}")))?;
            (Some(iv), Some(encrypted))
        }
        None => existing
            .as_ref()
            .map(|row| (row.token_iv.clone(), row.token_encrypted.clone()))
            .unwrap_or((None, None)),
    };

    let row = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, SiemSettingsRow>(
                r#"
                INSERT INTO siem_webhook_configs (
                    scope, organization_id, user_id, webhook_url, token_iv,
                    token_encrypted, enabled, updated_at
                )
                VALUES ('platform', NULL, NULL, $1, $2, $3, $4, NOW())
                ON CONFLICT (scope) WHERE scope = 'platform' DO UPDATE SET
                    webhook_url = EXCLUDED.webhook_url,
                    token_iv = EXCLUDED.token_iv,
                    token_encrypted = EXCLUDED.token_encrypted,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                RETURNING scope, organization_id, user_id, webhook_url, token_iv,
                          token_encrypted, enabled, updated_at
                "#,
            )
            .bind(webhook_url)
            .bind(token_iv)
            .bind(token_encrypted)
            .bind(body.enabled)
            .fetch_one(pool.get_ref())
            .await
        }
        Scope::Organization => {
            sqlx::query_as::<_, SiemSettingsRow>(
                r#"
                INSERT INTO siem_webhook_configs (
                    scope, organization_id, user_id, webhook_url, token_iv,
                    token_encrypted, enabled, updated_at
                )
                VALUES ('organization', $1, NULL, $2, $3, $4, $5, NOW())
                ON CONFLICT (organization_id) WHERE scope = 'organization' DO UPDATE SET
                    webhook_url = EXCLUDED.webhook_url,
                    token_iv = EXCLUDED.token_iv,
                    token_encrypted = EXCLUDED.token_encrypted,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                RETURNING scope, organization_id, user_id, webhook_url, token_iv,
                          token_encrypted, enabled, updated_at
                "#,
            )
            .bind(ctx.organization_id)
            .bind(webhook_url)
            .bind(token_iv)
            .bind(token_encrypted)
            .bind(body.enabled)
            .fetch_one(pool.get_ref())
            .await
        }
        Scope::Personal => {
            sqlx::query_as::<_, SiemSettingsRow>(
                r#"
                INSERT INTO siem_webhook_configs (
                    scope, organization_id, user_id, webhook_url, token_iv,
                    token_encrypted, enabled, updated_at
                )
                VALUES ('personal', NULL, $1, $2, $3, $4, $5, NOW())
                ON CONFLICT (user_id) WHERE scope = 'personal' DO UPDATE SET
                    webhook_url = EXCLUDED.webhook_url,
                    token_iv = EXCLUDED.token_iv,
                    token_encrypted = EXCLUDED.token_encrypted,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                RETURNING scope, organization_id, user_id, webhook_url, token_iv,
                          token_encrypted, enabled, updated_at
                "#,
            )
            .bind(ctx.user_id)
            .bind(webhook_url)
            .bind(token_iv)
            .bind(token_encrypted)
            .bind(body.enabled)
            .fetch_one(pool.get_ref())
            .await
        }
    }?;

    Ok(HttpResponse::Ok().json(row.into_view()))
}

#[post("/audit/siem-settings/test")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn test_siem_settings(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::WebhooksManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let Some(row) =
        load_siem_settings_for_scope(pool.get_ref(), ctx.scope, ctx.organization_id, ctx.user_id)
            .await?
    else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "No SIEM webhook is configured" })));
    };
    if !row.enabled {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "SIEM webhook is disabled" })));
    }

    let token = decrypt_siem_token(&row)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut request = client.post(&row.webhook_url).json(&serde_json::json!({
        "event_type": "siem_webhook_test",
        "scope": ctx.scope.as_str(),
        "user_id": ctx.user_id,
        "created_at": Utc::now(),
    }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => Ok(HttpResponse::Ok()
            .json(serde_json::json!({ "ok": true, "status": response.status().as_u16() }))),
        Ok(response) => Ok(HttpResponse::BadGateway().json(serde_json::json!({
            "message": "SIEM webhook returned a non-success status",
            "status": response.status().as_u16()
        }))),
        Err(error) => {
            warn!(target: "auth", error = ?error, "SIEM webhook test failed");
            Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "SIEM webhook request failed" })))
        }
    }
}

async fn load_siem_settings_for_scope(
    pool: &PgPool,
    scope: Scope,
    organization_id: Option<i32>,
    user_id: i32,
) -> sqlx::Result<Option<SiemSettingsRow>> {
    match scope {
        Scope::Platform => {
            sqlx::query_as::<_, SiemSettingsRow>(
                "SELECT scope, organization_id, user_id, webhook_url, token_iv,
                        token_encrypted, enabled, updated_at
                 FROM siem_webhook_configs
                 WHERE scope = 'platform'",
            )
            .fetch_optional(pool)
            .await
        }
        Scope::Organization => {
            sqlx::query_as::<_, SiemSettingsRow>(
                "SELECT scope, organization_id, user_id, webhook_url, token_iv,
                        token_encrypted, enabled, updated_at
                 FROM siem_webhook_configs
                 WHERE scope = 'organization' AND organization_id = $1",
            )
            .bind(organization_id)
            .fetch_optional(pool)
            .await
        }
        Scope::Personal => {
            sqlx::query_as::<_, SiemSettingsRow>(
                "SELECT scope, organization_id, user_id, webhook_url, token_iv,
                        token_encrypted, enabled, updated_at
                 FROM siem_webhook_configs
                 WHERE scope = 'personal' AND user_id = $1",
            )
            .bind(user_id)
            .fetch_optional(pool)
            .await
        }
    }
}

fn scope_org_id(scope: Scope, organization_id: Option<i32>) -> Option<i32> {
    (scope == Scope::Organization)
        .then_some(organization_id)
        .flatten()
}

fn scope_user_id(scope: Scope, user_id: i32) -> Option<i32> {
    (scope == Scope::Personal).then_some(user_id)
}

fn decrypt_siem_token(row: &SiemSettingsRow) -> Result<Option<String>, AppError> {
    match (&row.token_iv, &row.token_encrypted) {
        (Some(iv), Some(encrypted)) if !iv.is_empty() && !encrypted.is_empty() => {
            decrypt(iv, encrypted)
                .map(Some)
                .map_err(|e| AppError::Internal(format!("SIEM token decrypt failed: {e}")))
        }
        _ => Ok(None),
    }
}
