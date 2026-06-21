//! Per-user Jira connection endpoints + on-demand issue import. All gated by
//! authentication only (per-user, like IMAP email accounts) — no RBAC
//! permission. The API token is stored encrypted at rest via
//! `wayve_security::encryption` (the same symmetric scheme as `routes/sso.rs`).

use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;

use super::client::JiraClient;
use super::models::{ConnectInput, ConnectionStatus, ImportInput, JiraConnection};

const DEFAULT_JQL: &str =
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const DEFAULT_IMPORT: u32 = 100;
const MAX_IMPORT: u32 = 500;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_connection)
        .service(connect)
        .service(disconnect)
        .service(import_issues);
}

/// Load + decrypt the caller's Jira connection, if any.
pub(crate) async fn load_connection(
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<JiraConnection>, AppError> {
    let Some(row) = sqlx::query(
        "SELECT base_url, email, api_token_iv, api_token_encrypted, enabled
         FROM user_jira_connections WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let iv: String = row.get("api_token_iv");
    let enc: String = row.get("api_token_encrypted");
    let api_token = decrypt(&iv, &enc).map_err(|e| {
        warn!(target: "worker", error = %e, "jira token decrypt failed");
        AppError::Internal("Failed to read Jira credentials".into())
    })?;

    Ok(Some(JiraConnection {
        base_url: row.get("base_url"),
        email: row.get("email"),
        api_token,
        enabled: row.get("enabled"),
    }))
}

fn status_view(conn: Option<JiraConnection>) -> ConnectionStatus {
    match conn {
        Some(c) => ConnectionStatus {
            connected: true,
            base_url: Some(c.base_url),
            email: Some(c.email),
            enabled: c.enabled,
        },
        None => ConnectionStatus {
            connected: false,
            base_url: None,
            email: None,
            enabled: false,
        },
    }
}

#[get("/integrations/jira/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_connection(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let conn = load_connection(pool.get_ref(), user_id).await?;
    Ok(HttpResponse::Ok().json(status_view(conn)))
}

#[put("/integrations/jira/connection")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn connect(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ConnectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let base_url = body.base_url.trim().trim_end_matches('/').to_string();
    let email = body.email.trim().to_string();
    let token = body.api_token.trim().to_string();
    if base_url.is_empty() || email.is_empty() || token.is_empty() {
        return Err(AppError::bad_request(
            "base_url, email, and api_token are required",
        ));
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err(AppError::bad_request(
            "base_url must start with http:// or https://",
        ));
    }

    // Validate the credentials before storing them, so a bad token fails fast.
    let probe = JiraConnection {
        base_url: base_url.clone(),
        email: email.clone(),
        api_token: token.clone(),
        enabled: true,
    };
    JiraClient::new(&probe).test_connection().await?;

    let (iv, ciphertext) = encrypt(&token).map_err(|e| {
        warn!(target: "worker", error = %e, "jira token encrypt failed");
        AppError::Internal("Failed to store Jira credentials".into())
    })?;

    sqlx::query(
        "INSERT INTO user_jira_connections
            (user_id, base_url, email, api_token_iv, api_token_encrypted, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
            base_url = EXCLUDED.base_url,
            email = EXCLUDED.email,
            api_token_iv = EXCLUDED.api_token_iv,
            api_token_encrypted = EXCLUDED.api_token_encrypted,
            enabled = TRUE,
            updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&base_url)
    .bind(&email)
    .bind(&iv)
    .bind(&ciphertext)
    .execute(pool.get_ref())
    .await?;

    info!(target: "worker", user_id, "jira connection saved");
    Ok(HttpResponse::Ok().json(ConnectionStatus {
        connected: true,
        base_url: Some(base_url),
        email: Some(email),
        enabled: true,
    }))
}

#[delete("/integrations/jira/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM user_jira_connections WHERE user_id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "disconnected": true })))
}

#[post("/integrations/jira/import")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn import_issues(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ImportInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let Some(conn) = load_connection(pool.get_ref(), user_id).await? else {
        return Err(AppError::bad_request(
            "No Jira connection. Connect Jira first.",
        ));
    };
    if !conn.enabled {
        return Err(AppError::bad_request("Jira connection is disabled."));
    }

    let jql = body
        .jql
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_JQL);
    let max = body
        .max_results
        .unwrap_or(DEFAULT_IMPORT)
        .clamp(1, MAX_IMPORT);

    let (imported, updated) = super::sync::pull(pool.get_ref(), user_id, &conn, jql, max).await?;
    info!(target: "worker", user_id, imported, updated, "jira import complete");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "imported": imported, "updated": updated })))
}
