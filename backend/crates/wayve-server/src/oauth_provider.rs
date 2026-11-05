//! OAuth 2.0 authorization-code provider — "Connect with Fluxze".
//!
//! Lets a registered [`developer_app`](crate::routes::developer_apps) obtain a
//! user-consented, scoped access token, exactly how this app connects Google /
//! GitHub — but here Fluxze is the authorization server.
//!
//! Flow (Authorization Code, PKCE-capable):
//!  1. `GET /oauth/authorize` (browser, root) validates the request against the
//!     app's registered `redirect_uris`/`scopes`, identifies the logged-in user
//!     via the `rwayve_auth` cookie, stores a short-lived pending request, and
//!     redirects to the SPA consent page at `FRONTEND_URL/connect`.
//!  2. The SPA reads the request via `GET /api/oauth/consent/{id}` and posts the
//!     user's decision to `POST /api/oauth/consent/{id}`, which (on approve)
//!     mints a single-use authorization code and returns the redirect back to
//!     the app.
//!  3. The app's server exchanges the code at `POST /oauth/token` for an access
//!     token (`wv_oat_*`) + refresh token, presenting either its `client_secret`
//!     or a PKCE `code_verifier`.
//!
//! Access tokens are resolved by [`resolve_oauth_token`], which the API-key
//! middleware calls so a bearer `wv_oat_*` authenticates as its user, limited to
//! the granted scopes, across every handler unchanged.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, get, post, web};
use chrono::{DateTime, Duration, Utc};
use tracing::{info, instrument, warn};
use wayve_security::api_key::{
    generate_prefixed_token, hash_api_key, is_valid_scope, verify_pkce_s256,
};
use wayve_security::jwt::get_user_id_from_request;

const PENDING_TTL_MINS: i64 = 10;
const CODE_TTL_SECS: i64 = 60;
const ACCESS_TTL_SECS: i64 = 3600;
const REFRESH_TTL_DAYS: i64 = 30;

// ---------------------------------------------------------------------------
// Authorization endpoint (browser) — GET /oauth/authorize
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    pub response_type: Option<String>,
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    pub scope: Option<String>,
    pub state: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
}

/// A registered app row, minimal fields for the flow.
#[derive(FromRow)]
struct AppRow {
    id: i32,
    name: String,
    homepage_url: Option<String>,
    redirect_uris: Vec<String>,
    scopes: Vec<String>,
}

async fn load_app_by_client_id(pool: &PgPool, client_id: &str) -> Option<AppRow> {
    sqlx::query_as::<_, AppRow>(
        "SELECT id, name, homepage_url, redirect_uris, scopes
         FROM developer_apps WHERE client_id = $1 AND revoked_at IS NULL",
    )
    .bind(client_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// Append query params to a redirect URI, preserving any it already has.
fn redirect_with(base: &str, params: &[(&str, &str)]) -> String {
    match reqwest::Url::parse(base) {
        Ok(mut url) => {
            {
                let mut qp = url.query_pairs_mut();
                for (k, v) in params {
                    qp.append_pair(k, v);
                }
            }
            url.to_string()
        }
        // base was validated against the registered list before we get here.
        Err(_) => base.to_string(),
    }
}

fn found(location: String) -> HttpResponse {
    HttpResponse::Found()
        .append_header(("Location", location))
        .finish()
}

fn bad(msg: &str) -> HttpResponse {
    HttpResponse::BadRequest()
        .json(serde_json::json!({ "error": "invalid_request", "message": msg }))
}

/// Split a space-separated `scope` string, dropping empties.
fn parse_scope(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

#[get("/oauth/authorize")]
#[instrument(target = "auth", skip(req, pool, query))]
pub async fn authorize(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AuthorizeQuery>,
) -> impl Responder {
    let pool = pool.get_ref();

    // client_id + redirect_uri must be valid before we redirect anywhere: an
    // unregistered redirect is never trusted (open-redirect / code exfil).
    let Some(client_id) = query.client_id.as_deref().filter(|s| !s.is_empty()) else {
        return bad("client_id is required");
    };
    let Some(app) = load_app_by_client_id(pool, client_id).await else {
        return bad("Unknown or revoked client_id");
    };
    let Some(redirect_uri) = query.redirect_uri.as_deref().filter(|s| !s.is_empty()) else {
        return bad("redirect_uri is required");
    };
    if !app.redirect_uris.iter().any(|u| u == redirect_uri) {
        return bad("redirect_uri does not match a registered URI");
    }

    let state = query.state.clone();
    // From here, protocol errors go back to the app via the redirect.
    let err_back = |error: &str| {
        let mut params = vec![("error", error)];
        if let Some(s) = state.as_deref() {
            params.push(("state", s));
        }
        found(redirect_with(redirect_uri, &params))
    };

    if query.response_type.as_deref() != Some("code") {
        return err_back("unsupported_response_type");
    }

    // Requested scopes must be a subset of what the app registered.
    let requested = parse_scope(query.scope.as_deref());
    for s in &requested {
        if !is_valid_scope(s) || s == "*" || !app.scopes.iter().any(|a| a == s) {
            return err_back("invalid_scope");
        }
    }

    // PKCE: only S256 is accepted when a challenge is present.
    if query.code_challenge.is_some()
        && query.code_challenge_method.as_deref().unwrap_or("plain") != "S256"
    {
        return err_back("invalid_request");
    }

    // Identify the user from the auth cookie; if absent, log in then return.
    let Some(user_id) = get_user_id_from_request(&req) else {
        let next = match req.uri().query() {
            Some(q) => format!("/oauth/authorize?{q}"),
            None => "/oauth/authorize".to_string(),
        };
        let base = format!(
            "{}/login",
            crate::config::frontend_url().trim_end_matches('/')
        );
        return found(redirect_with(&base, &[("next", &next)]));
    };

    // Stash the validated request; the SPA consent page drives the decision.
    let request_id = generate_prefixed_token("wv_oar_");
    let expires_at = Utc::now() + Duration::minutes(PENDING_TTL_MINS);
    let insert = sqlx::query(
        "INSERT INTO oauth_pending_authorizations
            (request_id, app_id, user_id, redirect_uri, scopes, state,
             code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&request_id)
    .bind(app.id)
    .bind(user_id)
    .bind(redirect_uri)
    .bind(&requested)
    .bind(&state)
    .bind(&query.code_challenge)
    .bind(&query.code_challenge_method)
    .bind(expires_at)
    .execute(pool)
    .await;
    if let Err(e) = insert {
        warn!(target: "auth", error = ?e, "oauth pending insert failed");
        return err_back("server_error");
    }

    info!(target: "auth", user_id, app_id = app.id, "oauth authorize -> consent");
    found(format!(
        "{}/connect?request_id={}",
        crate::config::frontend_url().trim_end_matches('/'),
        request_id
    ))
}

// ---------------------------------------------------------------------------
// Consent detail + decision (SPA) — /api/oauth/consent/{id}
// ---------------------------------------------------------------------------

#[derive(FromRow)]
struct PendingRow {
    app_id: i32,
    user_id: i32,
    redirect_uri: String,
    scopes: Vec<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    expires_at: DateTime<Utc>,
}

async fn load_pending(pool: &PgPool, request_id: &str) -> Option<PendingRow> {
    sqlx::query_as::<_, PendingRow>(
        "SELECT app_id, user_id, redirect_uri, scopes, state, code_challenge,
                code_challenge_method, expires_at
         FROM oauth_pending_authorizations WHERE request_id = $1",
    )
    .bind(request_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

#[get("/oauth/consent/{request_id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn consent_detail(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized().finish();
    };
    let request_id = path.into_inner();
    let Some(pending) = load_pending(pool.get_ref(), &request_id).await else {
        return HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Request not found" }));
    };
    if pending.user_id != user_id || pending.expires_at <= Utc::now() {
        return HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Request not found" }));
    }
    let app = sqlx::query_as::<_, AppRow>(
        "SELECT id, name, homepage_url, redirect_uris, scopes FROM developer_apps WHERE id = $1",
    )
    .bind(pending.app_id)
    .fetch_optional(pool.get_ref())
    .await
    .ok()
    .flatten();
    let Some(app) = app else {
        return HttpResponse::NotFound().json(serde_json::json!({ "message": "App not found" }));
    };

    HttpResponse::Ok().json(serde_json::json!({
        "app_name": app.name,
        "app_homepage": app.homepage_url,
        "scopes": pending.scopes,
        "redirect_uri": pending.redirect_uri,
    }))
}

#[derive(Deserialize)]
pub struct DecisionInput {
    pub approve: bool,
}

#[post("/oauth/consent/{request_id}")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn consent_decision(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
    body: web::Json<DecisionInput>,
) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized().finish();
    };
    let pool = pool.get_ref();
    let request_id = path.into_inner();
    let Some(pending) = load_pending(pool, &request_id).await else {
        return HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Request not found" }));
    };
    if pending.user_id != user_id || pending.expires_at <= Utc::now() {
        return HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Request not found" }));
    }

    // Single-use regardless of outcome.
    let _ = sqlx::query("DELETE FROM oauth_pending_authorizations WHERE request_id = $1")
        .bind(&request_id)
        .execute(pool)
        .await;

    let state = pending.state.as_deref();
    if !body.approve {
        let mut params = vec![("error", "access_denied")];
        if let Some(s) = state {
            params.push(("state", s));
        }
        return HttpResponse::Ok().json(
            serde_json::json!({ "redirect_to": redirect_with(&pending.redirect_uri, &params) }),
        );
    }

    // Mint a single-use authorization code.
    let code = generate_prefixed_token("wv_oac_");
    let code_hash = hash_api_key(&code);
    let expires_at = Utc::now() + Duration::seconds(CODE_TTL_SECS);
    let insert = sqlx::query(
        "INSERT INTO oauth_auth_codes
            (code_hash, app_id, user_id, redirect_uri, scopes,
             code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&code_hash)
    .bind(pending.app_id)
    .bind(user_id)
    .bind(&pending.redirect_uri)
    .bind(&pending.scopes)
    .bind(&pending.code_challenge)
    .bind(&pending.code_challenge_method)
    .bind(expires_at)
    .execute(pool)
    .await;
    if let Err(e) = insert {
        warn!(target: "auth", error = ?e, "oauth code insert failed");
        return HttpResponse::InternalServerError().finish();
    }

    info!(target: "auth", user_id, app_id = pending.app_id, "oauth consent approved");
    let mut params = vec![("code", code.as_str())];
    if let Some(s) = state {
        params.push(("state", s));
    }
    HttpResponse::Ok()
        .json(serde_json::json!({ "redirect_to": redirect_with(&pending.redirect_uri, &params) }))
}

// ---------------------------------------------------------------------------
// Token endpoint (server-to-server) — POST /oauth/token
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TokenRequest {
    pub grant_type: Option<String>,
    // authorization_code
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_verifier: Option<String>,
    // refresh_token
    pub refresh_token: Option<String>,
    // client auth
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

fn token_error(error: &str, description: &str) -> HttpResponse {
    HttpResponse::BadRequest()
        .json(serde_json::json!({ "error": error, "error_description": description }))
}

#[derive(FromRow)]
struct CodeRow {
    app_id: i32,
    user_id: i32,
    redirect_uri: String,
    scopes: Vec<String>,
    code_challenge: Option<String>,
    expires_at: DateTime<Utc>,
}

#[post("/oauth/token")]
#[instrument(target = "auth", skip(pool, form))]
pub async fn token(pool: web::Data<PgPool>, form: web::Form<TokenRequest>) -> impl Responder {
    let pool = pool.get_ref();
    match form.grant_type.as_deref() {
        Some("authorization_code") => token_from_code(pool, &form).await,
        Some("refresh_token") => token_from_refresh(pool, &form).await,
        _ => token_error(
            "unsupported_grant_type",
            "grant_type must be authorization_code or refresh_token",
        ),
    }
}

/// Confirm the client identity behind `app_id`: a matching `client_secret`, or a
/// PKCE `code_verifier` when the code carried a challenge (public client).
#[allow(clippy::too_many_arguments)]
async fn authenticate_client(
    pool: &PgPool,
    app_id: i32,
    client_id: Option<&str>,
    client_secret: Option<&str>,
    code_challenge: Option<&str>,
    code_verifier: Option<&str>,
) -> Result<(), HttpResponse> {
    // The presented client_id must resolve to this code's app.
    let by_client: Option<i32> = match client_id {
        Some(cid) => sqlx::query_scalar(
            "SELECT id FROM developer_apps WHERE client_id = $1 AND revoked_at IS NULL",
        )
        .bind(cid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten(),
        None => None,
    };
    if by_client != Some(app_id) {
        return Err(token_error("invalid_client", "Unknown client_id"));
    }

    if let Some(challenge) = code_challenge {
        // PKCE path.
        match code_verifier {
            Some(verifier) if verify_pkce_s256(verifier, challenge) => Ok(()),
            _ => Err(token_error("invalid_grant", "PKCE verification failed")),
        }
    } else {
        // Confidential path: the client_secret must match the stored hash.
        let stored: Option<String> =
            sqlx::query_scalar("SELECT client_secret_hash FROM developer_apps WHERE id = $1")
                .bind(app_id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
        match (client_secret, stored) {
            (Some(secret), Some(hash)) if hash_api_key(secret) == hash => Ok(()),
            _ => Err(token_error("invalid_client", "Invalid client_secret")),
        }
    }
}

/// Issue an access + refresh token pair for `(app, user, scopes)`.
async fn issue_tokens(
    pool: &PgPool,
    app_id: i32,
    user_id: i32,
    scopes: &[String],
) -> Result<HttpResponse, HttpResponse> {
    let access = generate_prefixed_token("wv_oat_");
    let refresh = generate_prefixed_token("wv_ort_");
    let access_exp = Utc::now() + Duration::seconds(ACCESS_TTL_SECS);
    let refresh_exp = Utc::now() + Duration::days(REFRESH_TTL_DAYS);

    let res = sqlx::query(
        "INSERT INTO oauth_tokens
            (access_token_hash, refresh_token_hash, app_id, user_id, scopes,
             access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(hash_api_key(&access))
    .bind(hash_api_key(&refresh))
    .bind(app_id)
    .bind(user_id)
    .bind(scopes)
    .bind(access_exp)
    .bind(refresh_exp)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "auth", error = ?e, "oauth token insert failed");
        return Err(HttpResponse::InternalServerError().finish());
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_SECS,
        "refresh_token": refresh,
        "scope": scopes.join(" "),
    })))
}

async fn token_from_code(pool: &PgPool, form: &TokenRequest) -> HttpResponse {
    let Some(code) = form.code.as_deref() else {
        return token_error("invalid_request", "code is required");
    };
    let code_hash = hash_api_key(code);

    // Atomically consume the code (single-use): only the first exchange wins.
    let row = sqlx::query_as::<_, CodeRow>(
        "UPDATE oauth_auth_codes SET consumed_at = NOW()
          WHERE code_hash = $1 AND consumed_at IS NULL
        RETURNING app_id, user_id, redirect_uri, scopes, code_challenge, expires_at",
    )
    .bind(&code_hash)
    .fetch_optional(pool)
    .await;
    let code_row = match row {
        Ok(Some(r)) => r,
        Ok(None) => return token_error("invalid_grant", "Code is invalid or already used"),
        Err(e) => {
            warn!(target: "auth", error = ?e, "oauth code consume failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    if code_row.expires_at <= Utc::now() {
        return token_error("invalid_grant", "Code has expired");
    }
    // redirect_uri must match the one the code was issued for.
    if form.redirect_uri.as_deref() != Some(code_row.redirect_uri.as_str()) {
        return token_error("invalid_grant", "redirect_uri mismatch");
    }

    if let Err(resp) = authenticate_client(
        pool,
        code_row.app_id,
        form.client_id.as_deref(),
        form.client_secret.as_deref(),
        code_row.code_challenge.as_deref(),
        form.code_verifier.as_deref(),
    )
    .await
    {
        return resp;
    }

    match issue_tokens(pool, code_row.app_id, code_row.user_id, &code_row.scopes).await {
        Ok(resp) | Err(resp) => resp,
    }
}

#[derive(FromRow)]
struct RefreshRow {
    id: i64,
    app_id: i32,
    scopes: Vec<String>,
    refresh_expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

async fn token_from_refresh(pool: &PgPool, form: &TokenRequest) -> HttpResponse {
    let Some(refresh) = form.refresh_token.as_deref() else {
        return token_error("invalid_request", "refresh_token is required");
    };
    let row = sqlx::query_as::<_, RefreshRow>(
        "SELECT id, app_id, scopes, refresh_expires_at, revoked_at
         FROM oauth_tokens WHERE refresh_token_hash = $1",
    )
    .bind(hash_api_key(refresh))
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let Some(row) = row else {
        return token_error("invalid_grant", "Unknown refresh token");
    };
    if row.revoked_at.is_some()
        || row
            .refresh_expires_at
            .map(|e| e <= Utc::now())
            .unwrap_or(true)
    {
        return token_error("invalid_grant", "Refresh token is expired or revoked");
    }

    // Refresh is a confidential operation — require the client_secret.
    if let Err(resp) = authenticate_client(
        pool,
        row.app_id,
        form.client_id.as_deref(),
        form.client_secret.as_deref(),
        None,
        None,
    )
    .await
    {
        return resp;
    }

    // Rotate the access token on the same row; the refresh token is preserved.
    let access = generate_prefixed_token("wv_oat_");
    let access_exp = Utc::now() + Duration::seconds(ACCESS_TTL_SECS);
    let res = sqlx::query(
        "UPDATE oauth_tokens SET access_token_hash = $2, access_expires_at = $3, last_used_at = NOW()
          WHERE id = $1",
    )
    .bind(row.id)
    .bind(hash_api_key(&access))
    .bind(access_exp)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "auth", error = ?e, "oauth refresh rotate failed");
        return HttpResponse::InternalServerError().finish();
    }

    HttpResponse::Ok().json(serde_json::json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_SECS,
        "scope": row.scopes.join(" "),
    }))
}

// ---------------------------------------------------------------------------
// Access-token resolution (called by the API-key middleware)
// ---------------------------------------------------------------------------

#[derive(FromRow)]
struct AccessRow {
    user_id: i32,
    scopes: Vec<String>,
    access_expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

/// The user + scopes an `wv_oat_*` access token authenticates as, or `None` if
/// it is unknown, revoked, or expired. Best-effort stamps `last_used_at`.
pub async fn resolve_oauth_token(pool: &PgPool, raw: &str) -> Option<(i32, Vec<String>)> {
    let row: Option<AccessRow> = sqlx::query_as(
        "SELECT user_id, scopes, access_expires_at, revoked_at
         FROM oauth_tokens WHERE access_token_hash = $1",
    )
    .bind(hash_api_key(raw))
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let row = row?;
    if row.revoked_at.is_some() || row.access_expires_at <= Utc::now() {
        return None;
    }
    let (user_id, scopes) = (row.user_id, row.scopes);
    let _ =
        sqlx::query("UPDATE oauth_tokens SET last_used_at = NOW() WHERE access_token_hash = $1")
            .bind(hash_api_key(raw))
            .execute(pool)
            .await;
    Some((user_id, scopes))
}

/// The `wv_oat_` prefix that marks an OAuth access token in an `Authorization:
/// Bearer` header, distinguishing it from a session JWT.
pub const OAUTH_TOKEN_PREFIX: &str = "wv_oat_";

pub fn routes(cfg: &mut web::ServiceConfig) {
    // SPA-facing (under /api, normal auth).
    cfg.service(consent_detail).service(consent_decision);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    // Root-mounted: browser authorize + server-to-server token.
    cfg.service(authorize).service(token);
}
