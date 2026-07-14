//! Per-user GitLab connection endpoints and on-demand issue import. Gated by
//! authentication only, like the Jira integration: no RBAC permission and no
//! enterprise gate. The access token is stored encrypted at rest.

use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;

use super::client::GitlabClient;
use super::models::{ConnectInput, ConnectionStatus, GitlabConnection, ImportInput};

const DEFAULT_STATE: &str = "opened";
const DEFAULT_IMPORT: u32 = 100;
const MAX_IMPORT: u32 = 500;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_connection)
        .service(connect)
        .service(disconnect)
        .service(import_issues);
}

pub(crate) async fn load_connection(
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<GitlabConnection>, AppError> {
    let Some(row) = crate::db::with_rls_user_tx(pool, user_id, |mut tx| async move {
        let row = sqlx::query(
            "SELECT base_url, access_token_iv, access_token_encrypted, enabled
             FROM user_gitlab_connections WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await?
    else {
        return Ok(None);
    };

    let iv: String = row.get("access_token_iv");
    let enc: String = row.get("access_token_encrypted");
    let access_token = decrypt(&iv, &enc).map_err(|e| {
        warn!(target: "worker", error = %e, "gitlab token decrypt failed");
        AppError::Internal("Failed to read GitLab credentials".into())
    })?;

    Ok(Some(GitlabConnection {
        base_url: row.get("base_url"),
        access_token,
        enabled: row.get("enabled"),
    }))
}

fn status_view(conn: Option<GitlabConnection>) -> ConnectionStatus {
    match conn {
        Some(c) => ConnectionStatus {
            connected: true,
            base_url: Some(c.base_url),
            enabled: c.enabled,
        },
        None => ConnectionStatus {
            connected: false,
            base_url: None,
            enabled: false,
        },
    }
}

#[get("/integrations/gitlab/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_connection(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let conn = load_connection(pool.get_ref(), user_id).await?;
    Ok(HttpResponse::Ok().json(status_view(conn)))
}

#[put("/integrations/gitlab/connection")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn connect(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ConnectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let base_url = body
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://gitlab.com")
        .trim_end_matches('/')
        .to_string();
    let token = body.access_token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::bad_request("access_token is required"));
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err(AppError::bad_request(
            "base_url must start with http:// or https://",
        ));
    }

    // Validating before storing means a bad token fails fast.
    let probe = GitlabConnection {
        base_url: base_url.clone(),
        access_token: token.clone(),
        enabled: true,
    };
    GitlabClient::new(&probe).test_connection().await?;

    let (iv, ciphertext) = encrypt(&token).map_err(|e| {
        warn!(target: "worker", error = %e, "gitlab token encrypt failed");
        AppError::Internal("Failed to store GitLab credentials".into())
    })?;

    sqlx::query(
        "INSERT INTO user_gitlab_connections
            (user_id, base_url, access_token_iv, access_token_encrypted, enabled, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
            base_url = EXCLUDED.base_url,
            access_token_iv = EXCLUDED.access_token_iv,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            enabled = TRUE,
            updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&base_url)
    .bind(&iv)
    .bind(&ciphertext)
    .execute(pool.get_ref())
    .await?;

    info!(target: "worker", user_id, "gitlab connection saved");
    Ok(HttpResponse::Ok().json(ConnectionStatus {
        connected: true,
        base_url: Some(base_url),
        enabled: true,
    }))
}

#[delete("/integrations/gitlab/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM user_gitlab_connections WHERE user_id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "disconnected": true })))
}

#[post("/integrations/gitlab/import")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn import_issues(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ImportInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let Some(conn) = load_connection(pool.get_ref(), user_id).await? else {
        return Err(AppError::bad_request(
            "No GitLab connection. Connect GitLab first.",
        ));
    };
    if !conn.enabled {
        return Err(AppError::bad_request("GitLab connection is disabled."));
    }

    let state = body
        .state
        .as_deref()
        .map(str::trim)
        .filter(|s| matches!(*s, "opened" | "closed" | "all"))
        .unwrap_or(DEFAULT_STATE);
    let max = body
        .max_results
        .unwrap_or(DEFAULT_IMPORT)
        .clamp(1, MAX_IMPORT);

    let (imported, updated) = super::sync::pull(pool.get_ref(), user_id, &conn, state, max).await?;
    info!(target: "worker", user_id, imported, updated, "gitlab import complete");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "imported": imported, "updated": updated })))
}
