//! Slack OAuth connect, replacing the pasted `xoxb-` bot token.
//!
//! Connecting used to mean an admin creating a Slack app by hand, granting it
//! scopes, and copying its bot token into a form. This is the same flow every
//! other provider here uses: click Connect, approve in Slack, and the granted
//! bot token lands encrypted in `slack_connections` — the same row and columns
//! the paste flow wrote, so channel linking and history import are untouched.
//!
//! Mirrors `github_oauth.rs`, including the `oauth_states` nonce that makes the
//! callback safe to expose. The connection stays org-wide (Slack workspaces are
//! shared), so the caller must be an enterprise org member, exactly as before.
//!
//! Routes live under `/api/slack-oauth/*`, away from the `/api/slack/*` handlers
//! that manage an already-connected workspace.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, Responder, get, post, web};
use serde_json::Value;
use sqlx::Row;
use tracing::{error, info, instrument};
use wayve_security::encryption::encrypt;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::oauth::{consume_state, create_oauth_state};

const OAUTH_FLOW: &str = "slack_connect";
/// Bot scopes the existing Slack features need: read channels and history,
/// post replies back, and resolve user names on imported messages.
const SLACK_SCOPE: &str =
    "channels:read,channels:history,groups:read,groups:history,chat:write,users:read,team:read";

fn slack_client() -> Option<(String, String)> {
    let cfg = crate::config::slack_oauth();
    match (cfg.client_id, cfg.client_secret) {
        (Some(id), Some(secret)) => Some((id, secret)),
        _ => None,
    }
}

/// Must match the Slack app's registered redirect URL exactly.
fn slack_redirect_uri() -> String {
    if let Some(uri) = crate::config::slack_oauth().redirect_uri {
        return uri;
    }
    match crate::config::backend_url() {
        Some(base) => format!("{}/slack/oauth/callback", base.trim_end_matches('/')),
        None => "http://localhost:8080/slack/oauth/callback".to_string(),
    }
}

fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(&crate::external::slack_oauth_authorize_url())
        .unwrap_or_else(|err| panic!("valid Slack authorize URL: {err}"));
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("scope", SLACK_SCOPE)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state);
    url.to_string()
}

/// The caller's organization, or `Forbidden` unless it is on the enterprise
/// tier. The same gate `integrations::slack::handler` applies — connecting must
/// not be a way around it.
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

/// Begin the connect flow, returning the Slack authorize URL for the browser.
///
/// Returns a Responder rather than `AppResult` for the same reason
/// `github_connect` does: "not configured" is a 503 with a message the UI shows,
/// and the shared error taxonomy has no variant for it.
#[post("/slack-oauth/connect")]
#[instrument(target = "http", skip(req, pool))]
pub async fn slack_connect(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    // Checked before the redirect so an ineligible caller is told now, rather
    // than after approving the app in Slack.
    if enterprise_org(pool.get_ref(), user_id).await.is_err() {
        return HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Slack is available on the Enterprise plan" }));
    }
    let Some((client_id, _)) = slack_client() else {
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Slack OAuth is not configured" }));
    };
    let state = match create_oauth_state(Some(user_id), OAUTH_FLOW, pool.get_ref()).await {
        Ok(state) => state,
        Err(e) => {
            error!(target: "auth", error = %e, "slack oauth state store failed");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let url = authorize_url(&client_id, &slack_redirect_uri(), &state);
    info!(target: "auth", user_id, "slack oauth connect flow start");
    HttpResponse::Ok().json(serde_json::json!({ "url": url }))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Root-mounted and public: Slack redirects here with the auth code, and the app
/// bounces back to Integrations with `#connected=true` or `#slack_error=…`.
#[get("/slack/oauth/callback")]
#[instrument(target = "http", skip(pool, query))]
pub async fn slack_oauth_callback(
    pool: web::Data<PgPool>,
    query: web::Query<CallbackQuery>,
) -> impl Responder {
    let frontend = crate::config::frontend_url();
    let err_redirect = |reason: &str| {
        HttpResponse::Found()
            .append_header((
                "Location",
                format!("{frontend}/integrations#slack_error={reason}"),
            ))
            .finish()
    };

    if query.error.is_some() {
        return err_redirect("denied");
    }
    let (Some(code), Some(state)) = (query.code.as_ref(), query.state.as_ref()) else {
        return err_redirect("missing_code");
    };
    let Some((client_id, client_secret)) = slack_client() else {
        return err_redirect("not_configured");
    };

    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(value)) => value,
        Ok(None) => return err_redirect("invalid_state"),
        Err(e) => {
            error!(target: "auth", error = %e, "slack oauth state lookup failed");
            return err_redirect("server_error");
        }
    };
    let Some(user_id) = oauth_state.user_id else {
        return err_redirect("invalid_state");
    };
    // Re-checked on the way back in: entitlement can lapse between the redirect
    // out and the redirect home.
    let org_id = match enterprise_org(pool.get_ref(), user_id).await {
        Ok(id) => id,
        Err(_) => return err_redirect("not_entitled"),
    };

    let redirect_uri = slack_redirect_uri();
    let token_resp = match HTTP_CLIENT
        .post(crate::external::slack_oauth_token_url())
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "http", error = %e, "slack token exchange failed");
            return err_redirect("slack_unreachable");
        }
    };
    let token_json: Value = match token_resp.json().await {
        Ok(value) => value,
        Err(_) => return err_redirect("bad_response"),
    };
    // Slack answers 200 with `ok: false` rather than an HTTP error status.
    if !token_json["ok"].as_bool().unwrap_or(false) {
        let slack_err = token_json["error"].as_str().unwrap_or("unknown");
        error!(target: "http", error = %slack_err, "slack oauth rejected");
        return err_redirect("exchange_failed");
    }

    // oauth.v2.access returns the bot token under access_token, alongside the
    // team it was installed into.
    let bot_token = token_json["access_token"].as_str().unwrap_or("");
    if bot_token.is_empty() {
        return err_redirect("no_token");
    }
    let team_id = token_json["team"]["id"].as_str().unwrap_or("").to_string();
    let team_name = token_json["team"]["name"]
        .as_str()
        .unwrap_or("Slack")
        .to_string();

    let (iv, ciphertext) = match encrypt(bot_token) {
        Ok(pair) => pair,
        Err(e) => {
            error!(target: "auth", error = ?e, "slack token encrypt failed");
            return err_redirect("server_error");
        }
    };

    // Upserts the same row the paste flow wrote, so an org reconnecting over
    // OAuth keeps its channel links.
    let write = sqlx::query(
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
    .await;

    if let Err(e) = write {
        error!(target: "db", org_id, error = ?e, "slack_connections upsert failed");
        return err_redirect("server_error");
    }

    info!(target: "auth", user_id, org_id, team = %team_name, "slack workspace connected");
    HttpResponse::Found()
        .append_header((
            "Location",
            format!("{frontend}/integrations#slack_connected=true"),
        ))
        .finish()
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(slack_connect);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(slack_oauth_callback);
}
