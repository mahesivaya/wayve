//! Slack endpoints: connect a workspace, list and link Slack channels to Wayve
//! channels, and import history. Every endpoint requires the caller's org to be on
//! the enterprise tier, because Slack needs server-readable chat. The bot token is
//! encrypted at rest.

use crate::prelude::*;
use actix_web::{delete, put};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;

use super::client::SlackClient;
use super::models::{ConnectInput, ConnectionStatus, ImportInput, LinkInput, SlackConnection};

const DEFAULT_IMPORT_LIMIT: u32 = 100;
const MAX_IMPORT_LIMIT: u32 = 1000;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_connection)
        .service(connect)
        .service(disconnect)
        .service(list_channels)
        .service(link_channel)
        .service(import);
}

/// `Forbidden` when the caller has no org or it isn't on the enterprise tier.
async fn enterprise_org(pool: &PgPool, user_id: i32) -> Result<i32, AppError> {
    let Some(row) = sqlx::query(
        "SELECT u.organization_id AS org_id,
                EXISTS(
                    SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                    WHERE s.organization_id = u.organization_id
                      AND s.status = 'active' AND p.tier = 'enterprise'
                ) AS is_enterprise
           FROM users u WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    else {
        return Err(AppError::Unauthorized);
    };
    let org_id: Option<i32> = row.try_get("org_id").unwrap_or(None);
    let is_enterprise: bool = row.get("is_enterprise");
    match (org_id, is_enterprise) {
        (Some(id), true) => Ok(id),
        _ => Err(AppError::Forbidden),
    }
}

pub(crate) async fn load_connection(
    pool: &PgPool,
    org_id: i32,
) -> Result<Option<SlackConnection>, AppError> {
    let Some(row) = sqlx::query(
        "SELECT bot_token_iv, bot_token_encrypted, team_name, enabled
           FROM slack_connections WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let iv: String = row.get("bot_token_iv");
    let enc: String = row.get("bot_token_encrypted");
    let bot_token = decrypt(&iv, &enc).map_err(|e| {
        warn!(target: "worker", error = %e, "slack token decrypt failed");
        AppError::Internal("Failed to read Slack credentials".into())
    })?;
    Ok(Some(SlackConnection {
        organization_id: org_id,
        bot_token,
        team_name: row.try_get("team_name").unwrap_or(None),
        enabled: row.get("enabled"),
    }))
}

#[get("/integrations/slack/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_connection(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;
    let conn = load_connection(pool.get_ref(), org_id).await?;
    Ok(HttpResponse::Ok().json(match conn {
        Some(c) => ConnectionStatus {
            connected: true,
            team_name: c.team_name,
            enabled: c.enabled,
        },
        None => ConnectionStatus {
            connected: false,
            team_name: None,
            enabled: false,
        },
    }))
}

#[put("/integrations/slack/connection")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn connect(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ConnectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;

    let token = body.bot_token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::bad_request("bot_token is required"));
    }

    // Validating before storing means a bad token fails fast. Uses the
    // caller-supplied variant so a rejected token is a 400 the panel can show,
    // not a 401 that the browser reads as an expired session and redirects on.
    let (team_name, team_id) = SlackClient::from_token(&token)
        .validate_supplied_token()
        .await?;

    let (iv, ciphertext) = encrypt(&token).map_err(|e| {
        warn!(target: "worker", error = %e, "slack token encrypt failed");
        AppError::Internal("Failed to store Slack credentials".into())
    })?;

    sqlx::query(
        "INSERT INTO slack_connections
            (organization_id, bot_token_iv, bot_token_encrypted, team_id, team_name,
             connected_by, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
         ON CONFLICT (organization_id) DO UPDATE SET
            bot_token_iv = EXCLUDED.bot_token_iv,
            bot_token_encrypted = EXCLUDED.bot_token_encrypted,
            team_id = EXCLUDED.team_id,
            team_name = EXCLUDED.team_name,
            connected_by = EXCLUDED.connected_by,
            enabled = TRUE,
            updated_at = NOW()",
    )
    .bind(org_id)
    .bind(&iv)
    .bind(&ciphertext)
    .bind(&team_id)
    .bind(&team_name)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;

    info!(target: "worker", org_id, "slack connection saved");
    Ok(HttpResponse::Ok().json(ConnectionStatus {
        connected: true,
        team_name,
        enabled: true,
    }))
}

#[delete("/integrations/slack/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;
    sqlx::query("DELETE FROM slack_connections WHERE organization_id = $1")
        .bind(org_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "disconnected": true })))
}

#[get("/integrations/slack/channels")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_channels(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;
    let Some(conn) = load_connection(pool.get_ref(), org_id).await? else {
        return Err(AppError::bad_request(
            "No Slack connection. Connect Slack first.",
        ));
    };
    let channels = SlackClient::new(&conn).list_channels().await?;
    Ok(HttpResponse::Ok().json(channels))
}

#[post("/integrations/slack/links")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn link_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<LinkInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;

    let slack_channel_id = body.slack_channel_id.trim().to_string();
    if slack_channel_id.is_empty() {
        return Err(AppError::bad_request("slack_channel_id is required"));
    }

    // Idempotent: a channel already linked returns its existing Wayve channel.
    if let Some(existing) = sqlx::query(
        "SELECT wayve_channel_id FROM slack_channel_links
          WHERE organization_id = $1 AND slack_channel_id = $2",
    )
    .bind(org_id)
    .bind(&slack_channel_id)
    .fetch_optional(pool.get_ref())
    .await?
    {
        let wid: i32 = existing.get("wayve_channel_id");
        return Ok(HttpResponse::Ok()
            .json(serde_json::json!({ "wayve_channel_id": wid, "already_linked": true })));
    }

    let chan_name = body
        .wayve_channel_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(body.slack_channel_name.as_deref())
        .unwrap_or("slack-import")
        .to_string();

    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "INSERT INTO channels (name, created_by, visibility)
         VALUES ($1, $2, 'private') RETURNING id",
    )
    .bind(&chan_name)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let wayve_channel_id: i32 = row.get("id");

    sqlx::query(
        "INSERT INTO channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
    )
    .bind(wayve_channel_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO slack_channel_links
            (organization_id, wayve_channel_id, slack_channel_id, slack_channel_name)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(org_id)
    .bind(wayve_channel_id)
    .bind(&slack_channel_id)
    .bind(body.slack_channel_name.as_deref())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    info!(target: "worker", org_id, wayve_channel_id, "slack channel linked");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "wayve_channel_id": wayve_channel_id,
        "name": chan_name,
        "slack_channel_id": slack_channel_id,
    })))
}

#[post("/integrations/slack/import")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn import(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ImportInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let org_id = enterprise_org(pool.get_ref(), user_id).await?;
    let Some(conn) = load_connection(pool.get_ref(), org_id).await? else {
        return Err(AppError::bad_request(
            "No Slack connection. Connect Slack first.",
        ));
    };
    if !conn.enabled {
        return Err(AppError::bad_request("Slack connection is disabled."));
    }

    let limit = body
        .limit
        .unwrap_or(DEFAULT_IMPORT_LIMIT)
        .clamp(1, MAX_IMPORT_LIMIT);
    let (imported, channels) = super::sync::import_all(
        pool.get_ref(),
        &conn,
        user_id,
        body.slack_channel_id.as_deref(),
        limit,
    )
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "imported": imported, "channels": channels })))
}
