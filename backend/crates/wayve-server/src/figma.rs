//! Figma: connect a designer's account, and attach design files to board items.
//!
//! Two halves that share a token:
//!
//! * **OAuth** (`/api/figma-oauth/*` + the public callback) mirrors
//!   `github_oauth.rs` exactly, with one difference that matters — Figma access
//!   tokens expire, so the refresh token is stored and spent automatically. A
//!   provider whose tokens expire without refresh handling looks like it works
//!   and then quietly stops weeks later.
//! * **Links** (`/api/figma/links/*`) attach a Figma URL to a ticket or a user
//!   story. Only a reference is stored — file key, node, and the name/thumbnail
//!   needed to draw a card without calling Figma on every board load. The design
//!   itself never leaves Figma, and reading its metadata uses the *caller's* own
//!   token, so nobody can attach a file they cannot already open.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, Responder, delete, get, post, web};
// The prelude re-exports only the Naive chrono types; these columns are
// TIMESTAMPTZ, which sqlx maps to DateTime<Utc>.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::Row;
use tracing::{error, info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::oauth::{consume_state, create_oauth_state};

const OAUTH_FLOW: &str = "figma_connect";
/// Read-only. The app only ever GETs file metadata.
const FIGMA_SCOPE: &str = "file_read";
/// Renew a token this close to expiry rather than waiting for a 401.
const REFRESH_SKEW_SECONDS: i64 = 300;

fn figma_client() -> Option<(String, String)> {
    let cfg = crate::config::figma_oauth();
    match (cfg.client_id, cfg.client_secret) {
        (Some(id), Some(secret)) => Some((id, secret)),
        _ => None,
    }
}

/// Must match the Figma app's registered callback exactly.
fn figma_redirect_uri() -> String {
    if let Some(uri) = crate::config::figma_oauth().redirect_uri {
        return uri;
    }
    match crate::config::backend_url() {
        Some(base) => format!("{}/figma/oauth/callback", base.trim_end_matches('/')),
        None => "http://localhost:8080/figma/oauth/callback".to_string(),
    }
}

fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(&crate::external::figma_oauth_authorize_url())
        .unwrap_or_else(|err| panic!("valid Figma authorize URL: {err}"));
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", FIGMA_SCOPE)
        .append_pair("state", state)
        .append_pair("response_type", "code");
    url.to_string()
}

// ---------------------------------------------------------------------------
// Figma URL parsing
// ---------------------------------------------------------------------------

/// The file key and optional node id inside a Figma URL.
#[derive(Debug, PartialEq)]
pub struct FigmaRef {
    pub file_key: String,
    pub node_id: Option<String>,
}

/// Pulls the file key and node out of a Figma link.
///
/// Figma has used several path shapes over the years (`/file/`, `/design/`,
/// `/proto/`, `/board/`), all with the key in the same position, so the segment
/// *after* the kind is what identifies the file. The node arrives as `node-id`
/// in either `1:23` or the older `1-23` spelling; it is normalised to colons,
/// which is what the REST API expects.
pub fn parse_figma_url(raw: &str) -> Option<FigmaRef> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?;
    if !(host == "figma.com" || host.ends_with(".figma.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let kind = segments.next()?;
    if !matches!(kind, "file" | "design" | "proto" | "board") {
        return None;
    }
    let file_key = segments.next()?.to_string();
    if file_key.is_empty() {
        return None;
    }
    let node_id = url
        .query_pairs()
        .find(|(k, _)| k == "node-id")
        .map(|(_, v)| v.replace('-', ":"));
    Some(FigmaRef { file_key, node_id })
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

struct StoredToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
}

async fn load_token(pool: &PgPool, user_id: i32) -> Option<StoredToken> {
    let row = sqlx::query(
        "SELECT access_token_iv, access_token_encrypted,
                refresh_token_iv, refresh_token_encrypted, expires_at
           FROM figma_accounts WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;

    let access = decrypt(
        row.try_get::<String, _>("access_token_iv").ok()?.as_str(),
        row.try_get::<String, _>("access_token_encrypted")
            .ok()?
            .as_str(),
    )
    .map_err(|e| warn!(target: "auth", user_id, error = %e, "figma token decrypt failed"))
    .ok()?;

    // A connection made before refresh tokens were issued still works until it
    // expires, so a missing refresh token is not an error.
    let refresh = match (
        row.try_get::<Option<String>, _>("refresh_token_iv").ok()?,
        row.try_get::<Option<String>, _>("refresh_token_encrypted")
            .ok()?,
    ) {
        (Some(iv), Some(ct)) => decrypt(&iv, &ct).ok(),
        _ => None,
    };

    Some(StoredToken {
        access_token: access,
        refresh_token: refresh,
        expires_at: row.try_get("expires_at").ok().flatten(),
    })
}

/// A usable access token for this caller, refreshing first when the stored one
/// is at or near expiry. `None` when unconnected, or when the refresh fails —
/// in which case the caller sees "not connected" and can reconnect.
async fn active_token(pool: &PgPool, user_id: i32) -> Option<String> {
    let stored = load_token(pool, user_id).await?;
    let expiring = stored
        .expires_at
        .is_some_and(|at| at <= Utc::now() + chrono::Duration::seconds(REFRESH_SKEW_SECONDS));
    if !expiring {
        return Some(stored.access_token);
    }
    let refresh_token = stored.refresh_token?;
    match refresh_access_token(pool, user_id, &refresh_token).await {
        Some(token) => Some(token),
        None => {
            warn!(target: "auth", user_id, "figma token refresh failed; connection needs redoing");
            None
        }
    }
}

/// Spends the refresh token, persists the new access token, and returns it.
async fn refresh_access_token(pool: &PgPool, user_id: i32, refresh_token: &str) -> Option<String> {
    let (client_id, client_secret) = figma_client()?;
    let resp = HTTP_CLIENT
        .post(crate::external::figma_oauth_token_url())
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .ok()?;
    let json: Value = resp.json().await.ok()?;
    let access_token = json["access_token"].as_str()?;
    let expires_at = json["expires_in"]
        .as_i64()
        .map(|secs| Utc::now() + chrono::Duration::seconds(secs));

    let (iv, ciphertext) = encrypt(access_token).ok()?;
    sqlx::query(
        "UPDATE figma_accounts
            SET access_token_iv = $2, access_token_encrypted = $3,
                expires_at = $4, updated_at = NOW()
          WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(&iv)
    .bind(&ciphertext)
    .bind(expires_at)
    .execute(pool)
    .await
    .ok()?;
    Some(access_token.to_string())
}

// ---------------------------------------------------------------------------
// OAuth endpoints
// ---------------------------------------------------------------------------

/// Begin the connect flow, returning the Figma authorize URL for the browser.
#[post("/figma-oauth/connect")]
#[instrument(target = "http", skip(req, pool))]
pub async fn figma_connect(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    let Some((client_id, _)) = figma_client() else {
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Figma OAuth is not configured" }));
    };
    let state = match create_oauth_state(Some(user_id), OAUTH_FLOW, pool.get_ref()).await {
        Ok(state) => state,
        Err(e) => {
            error!(target: "auth", error = %e, "figma oauth state store failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let url = authorize_url(&client_id, &figma_redirect_uri(), &state);
    info!(target: "auth", user_id, "figma oauth connect flow start");
    HttpResponse::Ok().json(serde_json::json!({ "url": url }))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Root-mounted and public: Figma redirects here with the auth code.
#[get("/figma/oauth/callback")]
#[instrument(target = "http", skip(pool, query))]
pub async fn figma_oauth_callback(
    pool: web::Data<PgPool>,
    query: web::Query<CallbackQuery>,
) -> impl Responder {
    let frontend = crate::config::frontend_url();
    let err_redirect = |reason: &str| {
        HttpResponse::Found()
            .append_header((
                "Location",
                format!("{frontend}/integrations#figma_error={reason}"),
            ))
            .finish()
    };

    if query.error.is_some() {
        return err_redirect("denied");
    }
    let (Some(code), Some(state)) = (query.code.as_ref(), query.state.as_ref()) else {
        return err_redirect("missing_code");
    };
    let Some((client_id, client_secret)) = figma_client() else {
        return err_redirect("not_configured");
    };

    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(value)) => value,
        Ok(None) => return err_redirect("invalid_state"),
        Err(e) => {
            error!(target: "auth", error = %e, "figma oauth state lookup failed");
            return err_redirect("server_error");
        }
    };
    let Some(user_id) = oauth_state.user_id else {
        return err_redirect("invalid_state");
    };

    let redirect_uri = figma_redirect_uri();
    let token_resp = match HTTP_CLIENT
        .post(crate::external::figma_oauth_token_url())
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "http", error = %e, "figma token exchange failed");
            return err_redirect("figma_unreachable");
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
    let refresh_token = token_json["refresh_token"].as_str();
    let expires_at = token_json["expires_in"]
        .as_i64()
        .map(|secs| Utc::now() + chrono::Duration::seconds(secs));

    // Who connected, for the "Connected as …" line.
    let me_resp = match HTTP_CLIENT
        .get(format!("{}/v1/me", crate::external::figma_api_base()))
        .bearer_auth(access_token)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "http", error = %e, "figma /v1/me lookup failed");
            return err_redirect("figma_unreachable");
        }
    };
    let me: Value = match me_resp.json().await {
        Ok(value) => value,
        Err(_) => return err_redirect("bad_response"),
    };
    let handle = me["handle"].as_str().unwrap_or("").to_string();
    let figma_user_id = me["id"].as_str().map(str::to_string);
    let email = me["email"].as_str().map(str::to_string);
    if handle.is_empty() {
        return err_redirect("no_user");
    }

    let (access_iv, access_ct) = match encrypt(access_token) {
        Ok(pair) => pair,
        Err(e) => {
            error!(target: "auth", error = ?e, "figma token encrypt failed");
            return err_redirect("server_error");
        }
    };
    // Encrypted separately so a rotation of one never rewrites the other.
    let refresh_pair = match refresh_token.map(encrypt) {
        Some(Ok((iv, ct))) => (Some(iv), Some(ct)),
        Some(Err(e)) => {
            error!(target: "auth", error = ?e, "figma refresh token encrypt failed");
            return err_redirect("server_error");
        }
        None => (None, None),
    };

    let write = sqlx::query(
        "INSERT INTO figma_accounts
           (user_id, figma_handle, figma_user_id, figma_email,
            access_token_iv, access_token_encrypted,
            refresh_token_iv, refresh_token_encrypted, expires_at, scope, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           figma_handle = EXCLUDED.figma_handle,
           figma_user_id = EXCLUDED.figma_user_id,
           figma_email = EXCLUDED.figma_email,
           access_token_iv = EXCLUDED.access_token_iv,
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           refresh_token_iv = EXCLUDED.refresh_token_iv,
           refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
           expires_at = EXCLUDED.expires_at,
           scope = EXCLUDED.scope,
           updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&handle)
    .bind(&figma_user_id)
    .bind(&email)
    .bind(&access_iv)
    .bind(&access_ct)
    .bind(&refresh_pair.0)
    .bind(&refresh_pair.1)
    .bind(expires_at)
    .bind(FIGMA_SCOPE)
    .execute(pool.get_ref())
    .await;

    if let Err(e) = write {
        error!(target: "db", user_id, error = ?e, "figma_accounts upsert failed");
        return err_redirect("server_error");
    }

    info!(target: "auth", user_id, handle = %handle, "figma account connected");
    HttpResponse::Found()
        .append_header((
            "Location",
            format!("{frontend}/integrations#figma_connected=true"),
        ))
        .finish()
}

/// Whether the caller's Figma is connected, and as whom.
#[get("/figma-oauth/connection")]
#[instrument(target = "http", skip(req, pool))]
pub async fn figma_connection(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let row =
        sqlx::query("SELECT figma_handle, figma_email FROM figma_accounts WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;
    Ok(match row {
        Some(row) => HttpResponse::Ok().json(serde_json::json!({
            "connected": true,
            "handle": row.try_get::<String, _>("figma_handle").unwrap_or_default(),
            "email": row.try_get::<Option<String>, _>("figma_email").ok().flatten(),
        })),
        None => HttpResponse::Ok().json(serde_json::json!({ "connected": false })),
    })
}

/// Disconnect, forgetting the stored tokens. Existing links keep the metadata
/// already captured — they are references, not a live Figma session.
#[delete("/figma-oauth/connect")]
#[instrument(target = "http", skip(req, pool))]
pub async fn figma_disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    sqlx::query("DELETE FROM figma_accounts WHERE user_id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    info!(target: "auth", user_id, "figma account disconnected");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "disconnected": true })))
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LinkInput {
    /// The Figma URL as pasted.
    pub url: String,
    /// Exactly one of these says which board item to attach to.
    #[serde(default)]
    pub ticket_id: Option<i32>,
    #[serde(default)]
    pub user_story_id: Option<i32>,
}

fn link_row_json(row: &sqlx::postgres::PgRow) -> Value {
    serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or_default(),
        "file_key": row.try_get::<String, _>("file_key").unwrap_or_default(),
        "node_id": row.try_get::<Option<String>, _>("node_id").ok().flatten(),
        "url": row.try_get::<String, _>("url").unwrap_or_default(),
        "name": row.try_get::<String, _>("name").unwrap_or_default(),
        "thumbnail_url": row.try_get::<Option<String>, _>("thumbnail_url").ok().flatten(),
        "file_modified_at": row
            .try_get::<Option<DateTime<Utc>>, _>("file_modified_at")
            .ok()
            .flatten()
            .map(|t| t.to_rfc3339()),
    })
}

const LINK_COLS: &str = "id, file_key, node_id, url, name, thumbnail_url, file_modified_at";

/// Attach a Figma file to a ticket or user story.
///
/// The metadata is read with the caller's own token, so a link can only be made
/// to a file they can already open — the connection grants no reach beyond what
/// the person already had.
#[post("/figma/links")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_link(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<LinkInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // Exactly one owner, matching the table's CHECK.
    let owner = match (body.ticket_id, body.user_story_id) {
        (Some(id), None) => (Some(id), None),
        (None, Some(id)) => (None, Some(id)),
        _ => {
            return Err(AppError::bad_request(
                "Provide exactly one of ticket_id or user_story_id",
            ));
        }
    };

    let parsed = parse_figma_url(&body.url)
        .ok_or_else(|| AppError::bad_request("That doesn't look like a Figma file link"))?;

    let Some(token) = active_token(pool.get_ref(), user_id).await else {
        return Err(AppError::bad_request("Connect Figma first"));
    };

    let resp = HTTP_CLIENT
        .get(format!(
            "{}/v1/files/{}?depth=1",
            crate::external::figma_api_base(),
            parsed.file_key
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| {
            error!(target: "http", error = %e, "figma file lookup failed");
            AppError::internal("figma unreachable")
        })?;

    if !resp.status().is_success() {
        // 403/404 both mean "not yours to see" from here.
        return Err(AppError::bad_request(
            "That Figma file couldn't be read with your account",
        ));
    }
    let file: Value = resp
        .json()
        .await
        .map_err(|_| AppError::internal("bad figma response"))?;

    let name = file["name"].as_str().unwrap_or("Untitled").to_string();
    let thumbnail_url = file["thumbnailUrl"].as_str().map(str::to_string);
    let file_modified_at = file["lastModified"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));

    let row = sqlx::query(&format!(
        "INSERT INTO figma_links
           (ticket_id, user_story_id, file_key, node_id, url, name,
            thumbnail_url, file_modified_at, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING {LINK_COLS}"
    ))
    .bind(owner.0)
    .bind(owner.1)
    .bind(&parsed.file_key)
    .bind(&parsed.node_id)
    .bind(body.url.trim())
    .bind(&name)
    .bind(&thumbnail_url)
    .bind(file_modified_at)
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await
    .map_err(|e| match &e {
        // The unique index caught the same frame being attached twice.
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::bad_request("That design is already attached")
        }
        _ => AppError::Db(e),
    })?;

    info!(target: "http", user_id, file = %parsed.file_key, "figma link created");
    Ok(HttpResponse::Ok().json(link_row_json(&row)))
}

#[derive(Deserialize)]
pub struct LinkQuery {
    #[serde(default)]
    pub ticket_id: Option<i32>,
    #[serde(default)]
    pub user_story_id: Option<i32>,
}

/// The designs attached to one board item.
#[get("/figma/links")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn list_links(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<LinkQuery>,
) -> AppResult {
    get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    if query.ticket_id.is_none() && query.user_story_id.is_none() {
        return Err(AppError::bad_request("Provide ticket_id or user_story_id"));
    }
    let rows = sqlx::query(&format!(
        "SELECT {LINK_COLS} FROM figma_links
          WHERE ($1::INTEGER IS NOT NULL AND ticket_id = $1)
             OR ($2::INTEGER IS NOT NULL AND user_story_id = $2)
          ORDER BY created_at ASC, id ASC"
    ))
    .bind(query.ticket_id)
    .bind(query.user_story_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.iter().map(link_row_json).collect::<Vec<_>>()))
}

/// Detach a design. Removes the reference only — nothing in Figma is touched.
#[delete("/figma/links/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_link(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let deleted = sqlx::query("DELETE FROM figma_links WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound("figma link"));
    }
    info!(target: "http", user_id, "figma link removed");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(figma_connect)
        .service(figma_connection)
        .service(figma_disconnect)
        .service(create_link)
        .service(list_links)
        .service(delete_link);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(figma_oauth_callback);
}

#[cfg(test)]
mod tests {
    use super::{FigmaRef, parse_figma_url};

    #[test]
    fn parses_the_url_shapes_figma_has_used() {
        // Every path kind puts the key in the same position.
        for kind in ["file", "design", "proto", "board"] {
            let parsed = parse_figma_url(&format!("https://www.figma.com/{kind}/abc123/Checkout"));
            assert_eq!(
                parsed,
                Some(FigmaRef {
                    file_key: "abc123".into(),
                    node_id: None
                }),
                "{kind} link should parse"
            );
        }
    }

    #[test]
    fn normalises_the_node_id_to_colons() {
        // Figma writes node ids with a dash in URLs and a colon in its API.
        let parsed = parse_figma_url("https://www.figma.com/design/abc123/App?node-id=12-345")
            .unwrap_or_else(|| panic!("should parse"));
        assert_eq!(parsed.node_id.as_deref(), Some("12:345"));

        let already = parse_figma_url("https://figma.com/file/abc123/App?node-id=12%3A345")
            .unwrap_or_else(|| panic!("should parse"));
        assert_eq!(already.node_id.as_deref(), Some("12:345"));
    }

    #[test]
    fn rejects_anything_that_is_not_a_figma_file() {
        // A lookalike host must not be treated as Figma — this is the check that
        // stops a link from pointing somewhere else entirely.
        assert!(parse_figma_url("https://figma.com.evil.test/file/abc/App").is_none());
        assert!(parse_figma_url("https://www.figma.com/files/recent").is_none());
        assert!(parse_figma_url("https://example.com/file/abc").is_none());
        assert!(parse_figma_url("not a url").is_none());
        assert!(parse_figma_url("https://www.figma.com/file/").is_none());
    }
}
