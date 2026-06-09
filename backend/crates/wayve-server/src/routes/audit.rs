use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, get, post, put, web};
use chrono::{DateTime, Utc};
use std::time::Duration;
use tracing::{instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::rbac::{self, Permission, Scope};

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
pub struct UserActionQuery {
    pub limit: Option<i64>,
    pub action: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct UserActionView {
    pub id: i64,
    pub actor_user_id: Option<i32>,
    pub actor_email: Option<String>,
    pub organization_id: Option<i32>,
    pub action: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    // Free-form event details (e.g. email from/to/subject for email_sent /
    // email_received). Org/platform-admin readable per the scoping below.
    pub metadata: Option<serde_json::Value>,
    pub ip: Option<String>,
    // Coarse geolocation of `ip`, resolved offline at write time (NULL for rows
    // written before the feature, system events, or unresolvable/private IPs).
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub created_at: DateTime<Utc>,
}

// GET /api/audit/user-actions — security-relevant user actions (password
// change, deletion, export/download, billing change, …) from `audit_logs`,
// scoped like the API-key audit: platform staff see everything, an org
// auditor sees their org, a personal user sees only their own actions.
#[get("/audit/user-actions")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_user_actions(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<UserActionQuery>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let limit = query
        .limit
        .unwrap_or(AUDIT_LOG_DEFAULT_LIMIT)
        .clamp(1, AUDIT_LOG_MAX_LIMIT);
    let action = query
        .action
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());

    let rows = sqlx::query_as::<_, UserActionView>(
        r#"
        SELECT a.id, a.actor_user_id, u.email AS actor_email, a.organization_id,
               a.action, a.resource_type, a.resource_id, a.metadata, a.ip,
               a.country, a.region, a.city, a.created_at
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::TEXT IS NULL OR a.action = $1)
          AND (
                $2 = 'platform'
                OR ($2 = 'organization' AND a.organization_id = $3)
                OR ($2 = 'personal' AND a.actor_user_id = $4)
          )
        ORDER BY a.created_at DESC
        LIMIT $5
        "#,
    )
    .bind(action)
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .bind(ctx.user_id)
    .bind(limit)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[derive(Deserialize)]
pub struct RegistrationTypeQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct RegistrationTypeView {
    pub id: i32,
    pub email: String,
    // 'local' (email + password registration), 'google' (Gmail OAuth) or
    // 'microsoft' (Outlook OAuth) — straight from users.auth_provider.
    pub auth_provider: String,
    pub created_at: Option<DateTime<Utc>>,
}

// GET /api/audit/registration-types — how each user signed up: local password
// registration vs Gmail (Google OAuth) vs Outlook (Microsoft OAuth), read from
// users.auth_provider. Owner-gated and scoped like /audit/user-actions
// (platform sees everyone, an org owner sees their members, a personal user
// sees only themselves).
#[get("/audit/registration-types")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_registration_types(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<RegistrationTypeQuery>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let limit = query
        .limit
        .unwrap_or(AUDIT_LOG_DEFAULT_LIMIT)
        .clamp(1, AUDIT_LOG_MAX_LIMIT);

    let rows = sqlx::query_as::<_, RegistrationTypeView>(
        r#"
        SELECT u.id,
               u.email,
               COALESCE(NULLIF(u.auth_provider, ''), 'local') AS auth_provider,
               (u.created_at AT TIME ZONE 'UTC') AS created_at
        FROM users u
        WHERE (
                $1 = 'platform'
                OR ($1 = 'organization' AND u.organization_id = $2)
                OR ($1 = 'personal' AND u.id = $3)
        )
        ORDER BY u.created_at DESC NULLS LAST
        LIMIT $4
        "#,
    )
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .bind(ctx.user_id)
    .bind(limit)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
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
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
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

// ──────────────────────────────────────────────────────────────────────
// Audit export — cursor-paginated stream for customer SIEMs that want to
// pull (not be pushed via the SIEM webhook). Emits JSONL (one row per
// line) or CSV depending on `format=`. Cursor is `before_id`: callers pull
// the next page by passing the last `id` of the previous response.
// ──────────────────────────────────────────────────────────────────────

const AUDIT_EXPORT_PAGE: i64 = 1_000;
const AUDIT_EXPORT_MAX: i64 = 10_000;

#[derive(Deserialize)]
pub struct AuditExportQuery {
    /// Only include rows created at or after this ISO-8601 timestamp.
    pub since: Option<DateTime<Utc>>,
    /// Cursor — return rows with id < this value. Pass the last `id` from
    /// the previous response to get the next page.
    pub before_id: Option<i64>,
    /// Max rows in this response. Capped at `AUDIT_EXPORT_MAX`.
    pub limit: Option<i64>,
    /// `jsonl` (default) or `csv`.
    pub format: Option<String>,
}

#[get("/audit/export")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn export_audit_logs(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AuditExportQuery>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let limit = query
        .limit
        .unwrap_or(AUDIT_EXPORT_PAGE)
        .clamp(1, AUDIT_EXPORT_MAX);
    let format = query
        .format
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "jsonl".to_string());
    if !matches!(format.as_str(), "jsonl" | "csv") {
        return Err(AppError::BadRequest(
            "format must be 'jsonl' or 'csv'".into(),
        ));
    }
    let is_csv = format == "csv";

    // Scope visibility same as /audit/logs: platform sees all, org sees
    // its own org, personal sees keys they minted or acted as.
    let rows = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
            SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                   l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
            FROM api_key_audit_log l
            LEFT JOIN api_keys ak ON ak.id = l.api_key_id
            WHERE ($1::TIMESTAMPTZ IS NULL OR l.created_at >= $1)
              AND ($2::BIGINT IS NULL OR l.id < $2)
            ORDER BY l.id DESC
            LIMIT $3
            "#,
            )
            .bind(query.since)
            .bind(query.before_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Organization => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
            SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                   l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
            FROM api_key_audit_log l
            LEFT JOIN api_keys ak ON ak.id = l.api_key_id
            WHERE ($1::TIMESTAMPTZ IS NULL OR l.created_at >= $1)
              AND ($2::BIGINT IS NULL OR l.id < $2)
              AND (
                ak.user_id IN (SELECT id FROM users WHERE organization_id = $3)
                OR l.user_id IN (SELECT id FROM users WHERE organization_id = $3)
                OR ak.created_by = $4
              )
            ORDER BY l.id DESC
            LIMIT $5
            "#,
            )
            .bind(query.since)
            .bind(query.before_id)
            .bind(ctx.organization_id)
            .bind(ctx.user_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Personal => {
            sqlx::query_as::<_, AuditLogView>(
                r#"
            SELECT l.id, l.api_key_id, ak.name AS api_key_name, ak.key_preview,
                   l.user_id, l.method, l.path, l.status_code, l.outcome, l.ip, l.created_at
            FROM api_key_audit_log l
            LEFT JOIN api_keys ak ON ak.id = l.api_key_id
            WHERE ($1::TIMESTAMPTZ IS NULL OR l.created_at >= $1)
              AND ($2::BIGINT IS NULL OR l.id < $2)
              AND (ak.created_by = $3 OR ak.user_id = $3 OR l.user_id = $3)
            ORDER BY l.id DESC
            LIMIT $4
            "#,
            )
            .bind(query.since)
            .bind(query.before_id)
            .bind(ctx.user_id)
            .bind(limit)
            .fetch_all(pool.get_ref())
            .await?
        }
    };

    let next_cursor = rows.last().map(|r| r.id);
    let count = rows.len();

    let body = if is_csv {
        let mut out = String::from(
            "id,api_key_id,api_key_name,user_id,method,path,status_code,outcome,ip,created_at\n",
        );
        for r in &rows {
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{}\n",
                r.id,
                r.api_key_id.map(|v| v.to_string()).unwrap_or_default(),
                csv_escape(r.api_key_name.as_deref().unwrap_or("")),
                r.user_id.map(|v| v.to_string()).unwrap_or_default(),
                r.method,
                csv_escape(&r.path),
                r.status_code,
                r.outcome,
                csv_escape(r.ip.as_deref().unwrap_or("")),
                r.created_at.to_rfc3339(),
            ));
        }
        out
    } else {
        let mut out = String::with_capacity(rows.len() * 220);
        for r in &rows {
            if let Ok(line) = serde_json::to_string(r) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    };

    let mut resp = HttpResponse::Ok();
    resp.content_type(if is_csv {
        "text/csv; charset=utf-8"
    } else {
        "application/x-ndjson"
    });
    // Next-cursor + count travel as response headers so a `curl -o file.jsonl`
    // pipeline can read them with `-D /tmp/headers` without polluting the body.
    resp.insert_header(("X-Audit-Count", count.to_string()));
    if let Some(cursor) = next_cursor {
        resp.insert_header(("X-Audit-Next-Cursor", cursor.to_string()));
    }
    Ok(resp.body(body))
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
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

/// Register this domain's routes. Called from `routes::routes` (the aggregator).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(list_audit_logs)
        .service(list_user_actions)
        .service(list_registration_types)
        .service(export_audit_logs)
        .service(get_siem_settings)
        .service(upsert_siem_settings)
        .service(test_siem_settings);
}
