use crate::prelude::*;
use crate::security::rbac::{self, Permission, Scope};
use actix_web::{HttpRequest, HttpResponse, get, web};
use chrono::{DateTime, Utc};
use tracing::instrument;

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
