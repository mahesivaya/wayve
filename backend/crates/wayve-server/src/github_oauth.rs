//! Per-user GitHub OAuth for personal accounts.
//!
//! Lets a personal user connect their own GitHub so the proxy can act as them
//! instead of using the shared `GITHUB_TOKEN` PAT. Mirrors the Gmail OAuth flow
//! in `email/oauth_flow.rs`. The token is stored encrypted at rest, never
//! returned to the browser, and used server-side for Personal-scope callers only.
//!
//! Routes live under `/api/github-oauth/*`, deliberately not `/api/github/*`,
//! where the greedy `GET /api/github/{tail}` proxy would swallow them.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, Responder, delete, get, post, web};
use serde_json::Value;
use tracing::{error, info, instrument, warn};
use wayve_security::encryption::encrypt;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::oauth::{consume_state, create_oauth_state};

const OAUTH_FLOW: &str = "github_connect";
/// `repo` covers public and private. GitHub OAuth Apps can't grant
/// read-only-private, so the token technically permits writes even though the app
/// only ever GETs with it.
const GITHUB_SCOPE: &str = "repo";

fn github_client() -> Option<(String, String)> {
    let cfg = crate::config::github_oauth();
    match (cfg.client_id, cfg.client_secret) {
        (Some(id), Some(secret)) => Some((id, secret)),
        _ => None,
    }
}

/// Must match the OAuth App's registered callback exactly.
fn github_redirect_uri() -> String {
    if let Some(uri) = crate::config::github_oauth().redirect_uri {
        return uri;
    }
    match crate::config::backend_url() {
        Some(base) => format!("{}/github/oauth/callback", base.trim_end_matches('/')),
        None => "http://localhost:8080/github/oauth/callback".to_string(),
    }
}

fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(&crate::external::github_oauth_authorize_url())
        .unwrap_or_else(|err| panic!("valid GitHub authorize URL: {err}"));
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", GITHUB_SCOPE)
        .append_pair("state", state);
    url.to_string()
}

/// The decrypted per-user GitHub token, used by the proxy to act as a
/// Personal-scope caller. `None` when unconnected or on any decrypt or DB error,
/// in which case the caller falls back to the shared token.
pub async fn stored_token_for(pool: &PgPool, user_id: i32) -> Option<String> {
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT access_token_iv, access_token_encrypted FROM github_accounts WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;
    match wayve_security::encryption::decrypt(&row.0, &row.1) {
        Ok(token) => Some(token),
        Err(e) => {
            warn!(target: "auth", user_id, error = %e, "github token decrypt failed");
            None
        }
    }
}

/// Begin the connect flow, returning the GitHub authorize URL for the browser.
#[post("/github-oauth/connect")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_connect(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    let Some((client_id, _)) = github_client() else {
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "GitHub OAuth is not configured" }));
    };
    let state = match create_oauth_state(Some(user_id), OAUTH_FLOW, pool.get_ref()).await {
        Ok(state) => state,
        Err(e) => {
            error!(target: "auth", error = %e, "github oauth state store failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let url = authorize_url(&client_id, &github_redirect_uri(), &state);
    info!(target: "auth", user_id, "github oauth connect flow start");
    HttpResponse::Ok().json(serde_json::json!({ "url": url }))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Root-mounted and public: GitHub redirects here with the auth code, and the app
/// bounces back with `#connected=true` or `#github_error=…`.
#[get("/github/oauth/callback")]
#[instrument(target = "http", skip(pool, query))]
pub async fn github_oauth_callback(
    pool: web::Data<PgPool>,
    query: web::Query<CallbackQuery>,
) -> impl Responder {
    let frontend = crate::config::frontend_url();
    let err_redirect = |reason: &str| {
        HttpResponse::Found()
            .append_header((
                "Location",
                format!("{frontend}/github#github_error={reason}"),
            ))
            .finish()
    };

    if query.error.is_some() {
        return err_redirect("denied");
    }
    let (Some(code), Some(state)) = (query.code.as_ref(), query.state.as_ref()) else {
        return err_redirect("missing_code");
    };
    let Some((client_id, client_secret)) = github_client() else {
        return err_redirect("not_configured");
    };

    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(value)) => value,
        Ok(None) => return err_redirect("invalid_state"),
        Err(e) => {
            error!(target: "auth", error = %e, "github oauth state lookup failed");
            return err_redirect("server_error");
        }
    };
    let Some(user_id) = oauth_state.user_id else {
        return err_redirect("invalid_state");
    };

    let redirect_uri = github_redirect_uri();
    let token_resp = match HTTP_CLIENT
        .post(crate::external::github_oauth_token_url())
        .header("Accept", "application/json")
        .header("User-Agent", "rwayve-app")
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
            error!(target: "http", error = %e, "github token exchange failed");
            return err_redirect("github_unreachable");
        }
    };
    let token_json: Value = match token_resp.json().await {
        Ok(value) => value,
        Err(_) => return err_redirect("bad_response"),
    };
    let access_token = token_json["access_token"].as_str().unwrap_or("");
    if access_token.is_empty() {
        return err_redirect("no_token");
    }
    let granted_scope = token_json["scope"].as_str().unwrap_or("").to_string();

    let user_resp = match HTTP_CLIENT
        .get(format!("{}/user", crate::external::github_api_base()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app")
        .bearer_auth(access_token)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "http", error = %e, "github /user lookup failed");
            return err_redirect("github_unreachable");
        }
    };
    let gh_user: Value = match user_resp.json().await {
        Ok(value) => value,
        Err(_) => return err_redirect("bad_response"),
    };
    let login = gh_user["login"].as_str().unwrap_or("").to_string();
    let github_user_id = gh_user["id"].as_i64();
    if login.is_empty() {
        return err_redirect("no_user");
    }

    // The token is never stored or transmitted in plaintext.
    let (iv, ciphertext) = match encrypt(access_token) {
        Ok(pair) => pair,
        Err(e) => {
            error!(target: "auth", error = ?e, "github token encrypt failed");
            return err_redirect("server_error");
        }
    };

    let write = sqlx::query(
        "INSERT INTO github_accounts
           (user_id, github_login, github_user_id, access_token_iv, access_token_encrypted, scope, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           github_login = EXCLUDED.github_login,
           github_user_id = EXCLUDED.github_user_id,
           access_token_iv = EXCLUDED.access_token_iv,
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           scope = EXCLUDED.scope,
           updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&login)
    .bind(github_user_id)
    .bind(&iv)
    .bind(&ciphertext)
    .bind(&granted_scope)
    .execute(pool.get_ref())
    .await;

    if let Err(e) = write {
        error!(target: "db", user_id, error = ?e, "github_accounts upsert failed");
        return err_redirect("server_error");
    }

    info!(target: "auth", user_id, login = %login, "github account connected");
    HttpResponse::Found()
        .append_header(("Location", format!("{frontend}/github#connected=true")))
        .finish()
}

/// Whether the caller's GitHub is connected, and as whom.
#[get("/github-oauth/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_connection(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    let login = sqlx::query_scalar::<_, String>(
        "SELECT github_login FROM github_accounts WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await;
    match login {
        Ok(Some(login)) => {
            HttpResponse::Ok().json(serde_json::json!({ "connected": true, "login": login }))
        }
        Ok(None) => HttpResponse::Ok().json(serde_json::json!({ "connected": false })),
        Err(e) => {
            error!(target: "db", user_id, error = ?e, "github connection lookup failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

/// Disconnect, forgetting the stored token.
#[delete("/github-oauth/connect")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    match sqlx::query("DELETE FROM github_accounts WHERE user_id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => {
            info!(target: "auth", user_id, "github account disconnected");
            HttpResponse::Ok().json(serde_json::json!({ "disconnected": true }))
        }
        Err(e) => {
            error!(target: "db", user_id, error = ?e, "github disconnect failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_connect)
        .service(github_connection)
        .service(github_disconnect);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_oauth_callback);
}
