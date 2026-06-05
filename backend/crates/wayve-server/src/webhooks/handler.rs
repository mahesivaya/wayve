// Customer-facing HTTP API for managing webhook subscriptions + reviewing
// delivery history. Gated by JWT auth (not API-key) so a key issued for a
// narrower scope can't silently subscribe its owner to event flows.

use crate::prelude::*;
use crate::webhooks::events::{Event, EventOwner};
use actix_web::{delete, put};
use chrono::{DateTime, Utc};
use rand::RngCore;
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(list_webhooks)
        .service(create_webhook)
        .service(update_webhook)
        .service(delete_webhook)
        .service(test_webhook)
        .service(list_deliveries)
        .service(list_event_catalog);
}

async fn user_org(pool: &PgPool, user_id: i32) -> Result<Option<i32>, sqlx::Error> {
    let row =
        sqlx::query_scalar::<_, Option<i32>>("SELECT organization_id FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.flatten())
}

fn endpoint_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    let events: Vec<String> = row.try_get("events").unwrap_or_default();
    let last_success: Option<DateTime<Utc>> = row.try_get("last_success_at").ok().flatten();
    let last_failure: Option<DateTime<Utc>> = row.try_get("last_failure_at").ok().flatten();
    let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
    serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or(0),
        "url": row.try_get::<String, _>("url").unwrap_or_default(),
        "description": row.try_get::<Option<String>, _>("description").ok().flatten(),
        "events": events,
        "enabled": row.try_get::<bool, _>("enabled").unwrap_or(false),
        "org_wide": row.try_get::<bool, _>("org_wide").unwrap_or(false),
        "organization_id": row.try_get::<Option<i32>, _>("organization_id").ok().flatten(),
        "secret_preview": row.try_get::<String, _>("secret_preview").unwrap_or_default(),
        "consecutive_failures": row.try_get::<i32, _>("consecutive_failures").unwrap_or(0),
        "last_success_at": last_success,
        "last_failure_at": last_failure,
        "created_at": created_at,
    })
}

#[get("/webhooks")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_webhooks(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = user_org(pool.get_ref(), user_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, url, description, events, enabled, org_wide, organization_id,
               secret_preview, consecutive_failures, last_success_at, last_failure_at,
               created_at
          FROM webhook_endpoints
         WHERE user_id = $1
            OR (org_wide = true AND $2::int IS NOT NULL AND organization_id = $2)
         ORDER BY id DESC
        "#,
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows.iter().map(endpoint_json).collect();
    Ok(HttpResponse::Ok().json(items))
}

#[derive(Deserialize)]
pub struct CreateWebhookInput {
    pub url: String,
    pub events: Vec<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub org_wide: bool,
}

fn validate_url(url: &str) -> std::result::Result<(), AppError> {
    // Production requires https. Dev escape hatches for hitting the host
    // from inside docker-compose: localhost, 127.0.0.1, host.docker.internal.
    let dev_ok = url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://host.docker.internal");
    if !(url.starts_with("https://") || dev_ok) {
        return Err(AppError::BadRequest(
            "Webhook URL must use https:// (localhost / 127.0.0.1 / host.docker.internal permitted for development)".into(),
        ));
    }
    Ok(())
}

fn validate_events(events: &[String]) -> std::result::Result<(), AppError> {
    if events.is_empty() {
        return Err(AppError::BadRequest(
            "Subscribe to at least one event type (or use \"*\" for all)".into(),
        ));
    }
    for e in events {
        if e == "*" {
            continue;
        }
        if !Event::ALL.contains(&e.as_str()) {
            return Err(AppError::BadRequest(format!(
                "Unknown event type: {e}. Allowed: {} or *",
                Event::ALL.join(", ")
            )));
        }
    }
    Ok(())
}

fn generate_secret() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(64 + 4);
    hex.push_str("whsec_");
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    let preview = format!("{}…{}", &hex[..12], &hex[hex.len() - 4..]);
    (hex, preview)
}

#[post("/webhooks")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateWebhookInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    validate_url(&data.url)?;
    validate_events(&data.events)?;

    let org_id = user_org(pool.get_ref(), user_id).await?;
    let org_wide = data.org_wide && org_id.is_some();
    if data.org_wide && org_id.is_none() {
        return Err(AppError::BadRequest(
            "org_wide subscriptions require an organization-scoped account".into(),
        ));
    }

    let (secret, preview) = generate_secret();
    let row = sqlx::query(
        r#"
        INSERT INTO webhook_endpoints
          (user_id, organization_id, org_wide, url, secret, secret_preview,
           events, description, enabled)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
        RETURNING id, url, description, events, enabled, org_wide, organization_id,
                  secret_preview, consecutive_failures, last_success_at, last_failure_at,
                  created_at
        "#,
    )
    .bind(user_id)
    .bind(org_id)
    .bind(org_wide)
    .bind(data.url.trim())
    .bind(&secret)
    .bind(&preview)
    .bind(&data.events)
    .bind(data.description.as_deref().map(str::trim))
    .fetch_one(pool.get_ref())
    .await?;

    // Return the raw secret exactly once. The customer needs it to verify
    // Wayve-Signature headers; we only store the value (and never re-reveal
    // it on subsequent list/update calls).
    let mut body = endpoint_json(&row);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("secret".to_string(), serde_json::Value::String(secret));
    }
    Ok(HttpResponse::Ok().json(body))
}

#[derive(Deserialize)]
pub struct UpdateWebhookInput {
    pub url: Option<String>,
    pub events: Option<Vec<String>>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
}

#[put("/webhooks/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<UpdateWebhookInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    if let Some(url) = &data.url {
        validate_url(url)?;
    }
    if let Some(events) = &data.events {
        validate_events(events)?;
    }

    let row = sqlx::query(
        r#"
        UPDATE webhook_endpoints SET
          url = COALESCE($1, url),
          events = COALESCE($2, events),
          description = COALESCE($3, description),
          enabled = COALESCE($4, enabled),
          consecutive_failures = CASE WHEN COALESCE($4, enabled) = true
                                       AND enabled = false
                                      THEN 0
                                      ELSE consecutive_failures END,
          updated_at = NOW()
        WHERE id = $5 AND user_id = $6
        RETURNING id, url, description, events, enabled, org_wide, organization_id,
                  secret_preview, consecutive_failures, last_success_at, last_failure_at,
                  created_at
        "#,
    )
    .bind(data.url.as_deref().map(str::trim))
    .bind(data.events.as_ref())
    .bind(data.description.as_deref().map(str::trim))
    .bind(data.enabled)
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("webhook"))?;

    Ok(HttpResponse::Ok().json(endpoint_json(&row)))
}

#[delete("/webhooks/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let done = sqlx::query("DELETE FROM webhook_endpoints WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("webhook"));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

#[post("/webhooks/{id}/test")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn test_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    // Confirm ownership before emitting; otherwise a user could trigger
    // pings into someone else's webhook.
    let owns = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM webhook_endpoints WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .is_some();
    if !owns {
        return Err(AppError::NotFound("webhook"));
    }
    // Insert a `pending` row directly targeted at this one endpoint, so the
    // test bypasses the normal fan-out predicate (and works even if the
    // endpoint hasn't subscribed to `wayve.ping`).
    let payload = serde_json::json!({
        "id": format!("evt_test_{}", uuid::Uuid::new_v4().simple()),
        "type": "wayve.ping",
        "api_version": "2026.05",
        "created_at": chrono::Utc::now(),
        "data": { "message": "If you can read this, your endpoint is wired up." }
    });
    sqlx::query(
        r#"
        INSERT INTO webhook_deliveries
          (endpoint_id, event_id, event_type, payload, next_attempt_at)
        VALUES ($1, $2, $3, $4, NOW())
        "#,
    )
    .bind(id)
    .bind(payload["id"].as_str().unwrap_or(""))
    .bind("wayve.ping")
    .bind(&payload)
    .execute(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "queued": true })))
}

#[get("/webhooks/{id}/deliveries")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn list_deliveries(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();

    let owns = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM webhook_endpoints WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .is_some();
    if !owns {
        return Err(AppError::NotFound("webhook"));
    }

    let rows = sqlx::query(
        r#"
        SELECT id, event_id, event_type, attempt_count, status, http_status,
               response_excerpt, next_attempt_at, delivered_at, created_at
          FROM webhook_deliveries
         WHERE endpoint_id = $1
         ORDER BY id DESC
         LIMIT 50
        "#,
    )
    .bind(id)
    .fetch_all(pool.get_ref())
    .await?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let next_attempt_at: Option<DateTime<Utc>> = row.try_get("next_attempt_at").ok();
            let delivered_at: Option<DateTime<Utc>> = row.try_get("delivered_at").ok().flatten();
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            serde_json::json!({
                "id": row.try_get::<i64, _>("id").unwrap_or(0),
                "event_id": row.try_get::<String, _>("event_id").unwrap_or_default(),
                "event_type": row.try_get::<String, _>("event_type").unwrap_or_default(),
                "attempt_count": row.try_get::<i32, _>("attempt_count").unwrap_or(0),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "http_status": row.try_get::<Option<i32>, _>("http_status").ok().flatten(),
                "response_excerpt": row.try_get::<Option<String>, _>("response_excerpt").ok().flatten(),
                "next_attempt_at": next_attempt_at,
                "delivered_at": delivered_at,
                "created_at": created_at,
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[get("/webhooks/events")]
pub async fn list_event_catalog() -> AppResult {
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "events": Event::ALL,
        "api_version": "2026.05",
    })))
}

// Helper for producers to discover their org context once.
pub async fn owner_for_user(pool: &PgPool, user_id: i32) -> EventOwner {
    match user_org(pool, user_id).await.unwrap_or(None) {
        Some(org) => EventOwner::user_in_org(user_id, org),
        None => EventOwner::user(user_id),
    }
}
