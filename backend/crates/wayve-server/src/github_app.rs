//! The Hadal GitHub App, which lets an organization share its own repositories,
//! private ones included, with its workspace.
//!
//! The organization owner installs the App on their GitHub account and picks the
//! repositories in GitHub's own screen. The server keeps only the installation
//! id (`github_installations`) and mints a one-hour installation token from the
//! App's private key whenever it needs one, so no long-lived secret is stored per
//! organization and access survives the installing person leaving.
//!
//! The install round-trip is checked twice before an installation is recorded:
//! the signed `state` names the organization and the owner who started it, and
//! the GitHub user who came back must be able to see that installation (GitHub's
//! `/user/installations`), so nobody can claim someone else's installation id.
//!
//! Routes live under `/api/github-app/*`, not `/api/github/*`, where the greedy
//! `GET /api/github/{tail}` proxy would swallow them. The callback sits under the
//! root `/github/oauth/` path that nginx already forwards to the backend.

use crate::cache::TtlCache;
use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use actix_web::delete;
use std::time::Duration;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::oauth::{consume_state, create_oauth_state};
use wayve_security::rbac::{self, Role, Scope, resolve_role_context_moded};

/// The `oauth_states.flow` prefix; the organization id follows the colon.
const INSTALL_FLOW: &str = "github_app_install";
/// Installation tokens live an hour; reuse one for 50 minutes.
const TOKEN_TTL_SECS: u64 = 50 * 60;
/// Pages of 100 read from GitHub's list endpoints, at most.
const MAX_PAGES: u32 = 10;
const USER_AGENT: &str = "rwayve-app";

static INSTALLATION_TOKENS: Lazy<TtlCache<i64, String>> =
    Lazy::new(|| TtlCache::new(1_000, TOKEN_TTL_SECS));

fn install_flow(org_id: i32) -> String {
    format!("{INSTALL_FLOW}:{org_id}")
}

/// The organization an install `flow` was started for, if it is one.
fn org_from_flow(flow: &str) -> Option<i32> {
    flow.strip_prefix(INSTALL_FLOW)?
        .strip_prefix(':')?
        .parse()
        .ok()
}

#[derive(Serialize)]
struct AppClaims {
    iat: i64,
    exp: i64,
    iss: String,
}

/// The App's own JWT, which GitHub accepts for `/app/*` calls. Backdated a
/// minute for clock drift and valid for nine (GitHub allows at most ten).
fn app_jwt(cfg: &crate::config::GithubAppConfig) -> std::result::Result<String, String> {
    let now = chrono::Utc::now().timestamp();
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(cfg.private_key.as_bytes())
        .map_err(|e| format!("invalid GitHub App private key: {e}"))?;
    let claims = AppClaims {
        iat: now - 60,
        exp: now + 9 * 60,
        iss: cfg.app_id.clone(),
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| format!("could not sign GitHub App JWT: {e}"))
}

fn github_get(url: &str, bearer: &str) -> reqwest::RequestBuilder {
    HTTP_CLIENT
        .get(url)
        .timeout(Duration::from_secs(15))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .bearer_auth(bearer)
}

/// A token that acts as the installation: it reads exactly the repositories the
/// organization shared. `None` when the App isn't configured, or GitHub refuses
/// (for example because the App was uninstalled), which is logged.
pub async fn installation_token(installation_id: i64) -> Option<String> {
    if let Some(token) = INSTALLATION_TOKENS.get(&installation_id).await {
        return Some(token);
    }
    let cfg = crate::config::github_app()?;
    let jwt = match app_jwt(&cfg) {
        Ok(jwt) => jwt,
        Err(e) => {
            error!(target: "auth", error = %e, "github app jwt failed");
            return None;
        }
    };
    let url = format!(
        "{}/app/installations/{installation_id}/access_tokens",
        crate::external::github_api_base()
    );
    let resp = HTTP_CLIENT
        .post(&url)
        .timeout(Duration::from_secs(15))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .bearer_auth(jwt)
        .send()
        .await;
    let resp = match resp {
        Ok(resp) => resp,
        Err(e) => {
            warn!(target: "http", installation_id, error = %e, "github installation token call failed");
            return None;
        }
    };
    if !resp.status().is_success() {
        warn!(target: "http", installation_id, status = resp.status().as_u16(),
              "github refused an installation token");
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let token = body.get("token")?.as_str()?.to_string();
    INSTALLATION_TOKENS
        .insert(installation_id, token.clone())
        .await;
    Some(token)
}

/// Drop a cached installation token, after the installation goes away.
pub async fn forget_installation(installation_id: i64) {
    INSTALLATION_TOKENS.invalidate(&installation_id).await;
}

/// The organization's installation: its id and the GitHub account it is on.
pub async fn org_installation(pool: &PgPool, org_id: i32) -> Option<(i64, String, Option<String>)> {
    sqlx::query_as::<_, (i64, String, Option<String>)>(
        "SELECT installation_id, account_login, account_type
           FROM github_installations WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .unwrap_or_else(|e| {
        warn!(target: "db", org_id, error = ?e, "github installation lookup failed");
        None
    })
}

/// A token for the organization's installation, if it has one that works.
pub async fn org_token(pool: &PgPool, org_id: i32) -> Option<String> {
    let (installation_id, _, _) = org_installation(pool, org_id).await?;
    installation_token(installation_id).await
}

/// For an organization caller whose organization installed the App: the
/// organization id and an installation token. `None` for everyone else.
pub async fn org_token_for_request(req: &HttpRequest, pool: &PgPool) -> Option<(i32, String)> {
    let user_id = get_user_id_from_request(req)?;
    let ctx = resolve_role_context_moded(req, pool, user_id).await.ok()?;
    if ctx.scope != Scope::Organization {
        return None;
    }
    let org_id = ctx.organization_id?;
    let token = org_token(pool, org_id).await?;
    Some((org_id, token))
}

/// Every repository the installation was given, in GitHub's repo shape.
pub async fn list_installation_repos(token: &str) -> std::result::Result<Vec<Value>, ()> {
    let api_base = crate::external::github_api_base();
    let mut repos = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!("{api_base}/installation/repositories?per_page=100&page={page}");
        let resp = github_get(&url, token).send().await.map_err(|e| {
            warn!(target: "http", error = %e, "github installation repos call failed");
        })?;
        if !resp.status().is_success() {
            warn!(target: "http", status = resp.status().as_u16(), "github installation repos refused");
            return Err(());
        }
        let body: Value = resp.json().await.map_err(|_| ())?;
        let batch = body
            .get("repositories")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let full_page = batch.len() == 100;
        repos.extend(batch);
        if !full_page {
            break;
        }
    }
    Ok(repos)
}

/// Where the account's owner changes which repositories the App can see.
fn manage_url(installation_id: i64, login: &str, account_type: Option<&str>) -> String {
    let web = crate::external::github_web_base();
    if account_type == Some("Organization") {
        format!("{web}/organizations/{login}/settings/installations/{installation_id}")
    } else {
        format!("{web}/settings/installations/{installation_id}")
    }
}

/// The organization owner, resolved in the caller's session mode. `Err` is the
/// response to send.
async fn require_org_owner(
    req: &HttpRequest,
    pool: &PgPool,
) -> std::result::Result<(i32, i32), HttpResponse> {
    let ctx = rbac::require_owner(req, pool).await?;
    match (ctx.scope, ctx.organization_id) {
        (Scope::Organization, Some(org_id)) => Ok((ctx.user_id, org_id)),
        _ => Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization owner can connect GitHub for the organization."
        }))),
    }
}

/// Whether the caller's organization has connected GitHub, and to which account.
#[get("/github-app/status")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_app_status(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let Some(user_id) = get_user_id_from_request(&req) else {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }));
    };
    let configured = crate::config::github_app().is_some();
    let ctx = match resolve_role_context_moded(&req, pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!(target: "auth", user_id, error = ?e, "github app status rbac resolution failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let installation = match (ctx.scope, ctx.organization_id) {
        (Scope::Organization, Some(org_id)) => org_installation(pool.get_ref(), org_id).await,
        _ => None,
    };
    match installation {
        Some((installation_id, login, account_type)) => {
            HttpResponse::Ok().json(serde_json::json!({
                "configured": configured,
                "connected": true,
                "account_login": login,
                // Only the owner gets the GitHub settings link they can act on.
                "manage_url": (ctx.role == Role::Owner)
                    .then(|| manage_url(installation_id, &login, account_type.as_deref())),
            }))
        }
        None => HttpResponse::Ok().json(serde_json::json!({
            "configured": configured,
            "connected": false,
        })),
    }
}

/// Begin installing the App: the browser goes to GitHub's install screen.
#[post("/github-app/install")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_app_install(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let (user_id, org_id) = match require_org_owner(&req, pool.get_ref()).await {
        Ok(ids) => ids,
        Err(resp) => return resp,
    };
    let Some(cfg) = crate::config::github_app() else {
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "message": "Connecting GitHub isn't set up on this server yet."
        }));
    };
    let state = match create_oauth_state(Some(user_id), &install_flow(org_id), pool.get_ref()).await
    {
        Ok(state) => state,
        Err(e) => {
            error!(target: "auth", error = %e, "github app state store failed");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let mut url = match reqwest::Url::parse(&format!(
        "{}/apps/{}/installations/new",
        crate::external::github_web_base(),
        cfg.slug
    )) {
        Ok(url) => url,
        Err(e) => {
            error!(target: "auth", error = %e, "github app install url invalid");
            return HttpResponse::InternalServerError().finish();
        }
    };
    url.query_pairs_mut().append_pair("state", &state);
    info!(target: "auth", user_id, org_id, "github app install flow start");
    HttpResponse::Ok().json(serde_json::json!({ "url": url.to_string() }))
}

/// Forget the organization's installation. The App stays installed on GitHub
/// until the account's owner removes it there (`manage_url`).
#[delete("/github-app/install")]
#[instrument(target = "http", skip(req, pool))]
pub async fn github_app_disconnect(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let (user_id, org_id) = match require_org_owner(&req, pool.get_ref()).await {
        Ok(ids) => ids,
        Err(resp) => return resp,
    };
    let removed = sqlx::query_scalar::<_, i64>(
        "DELETE FROM github_installations WHERE organization_id = $1 RETURNING installation_id",
    )
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await;
    match removed {
        Ok(installation_id) => {
            if let Some(id) = installation_id {
                INSTALLATION_TOKENS.invalidate(&id).await;
            }
            crate::github_proxy::invalidate_org_cache(org_id).await;
            info!(target: "auth", user_id, org_id, "github app disconnected");
            HttpResponse::Ok().json(serde_json::json!({ "disconnected": true }))
        }
        Err(e) => {
            error!(target: "db", org_id, error = ?e, "github app disconnect failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[derive(Deserialize)]
pub struct SetupQuery {
    pub installation_id: Option<String>,
    pub setup_action: Option<String>,
    pub state: Option<String>,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// Whether the GitHub user behind `user_token` can see `installation_id`.
async fn user_can_see_installation(
    user_token: &str,
    installation_id: i64,
) -> std::result::Result<bool, ()> {
    let api_base = crate::external::github_api_base();
    for page in 1..=MAX_PAGES {
        let url = format!("{api_base}/user/installations?per_page=100&page={page}");
        let resp = github_get(&url, user_token).send().await.map_err(|e| {
            warn!(target: "http", error = %e, "github /user/installations call failed");
        })?;
        if !resp.status().is_success() {
            return Err(());
        }
        let body: Value = resp.json().await.map_err(|_| ())?;
        let batch = body
            .get("installations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if batch
            .iter()
            .any(|i| i.get("id").and_then(Value::as_i64) == Some(installation_id))
        {
            return Ok(true);
        }
        if batch.len() < 100 {
            break;
        }
    }
    Ok(false)
}

/// Exchange the code GitHub sends back from the install for a user token.
async fn exchange_code(cfg: &crate::config::GithubAppConfig, code: &str) -> Option<String> {
    let resp = HTTP_CLIENT
        .post(crate::external::github_oauth_token_url())
        .timeout(Duration::from_secs(15))
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("code", code),
        ])
        .send()
        .await
        .map_err(|e| warn!(target: "http", error = %e, "github app code exchange failed"))
        .ok()?;
    let body: Value = resp.json().await.ok()?;
    body.get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// The account an installation is on: its login and type (`User` or
/// `Organization`).
async fn installation_account(
    cfg: &crate::config::GithubAppConfig,
    installation_id: i64,
) -> Option<(String, Option<String>)> {
    let jwt = app_jwt(cfg)
        .map_err(|e| error!(target: "auth", error = %e, "github app jwt failed"))
        .ok()?;
    let url = format!(
        "{}/app/installations/{installation_id}",
        crate::external::github_api_base()
    );
    let resp = github_get(&url, &jwt).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let account = body.get("account")?;
    let login = account.get("login")?.as_str()?.to_string();
    let kind = account
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((login, kind))
}

/// Root-mounted and public: GitHub sends the browser here after the install, and
/// it bounces back to Settings → Repositories with `#github_app=connected` or
/// `#github_app_error=<reason>`.
#[get("/github/oauth/app/setup")]
#[instrument(target = "http", skip(pool, query))]
pub async fn github_app_setup(
    pool: web::Data<PgPool>,
    query: web::Query<SetupQuery>,
) -> impl Responder {
    let frontend = crate::config::frontend_url();
    let back = |fragment: &str| {
        HttpResponse::Found()
            .append_header((
                "Location",
                format!(
                    "{}/settings/repositories#{fragment}",
                    frontend.trim_end_matches('/')
                ),
            ))
            .finish()
    };
    let fail = |reason: &str| back(&format!("github_app_error={reason}"));

    if query.error.is_some() {
        return fail("denied");
    }
    // Someone without the right to install asked their GitHub org's owner to;
    // there is nothing to record until that owner approves.
    if query.setup_action.as_deref() == Some("request") {
        return back("github_app=requested");
    }
    let Some(cfg) = crate::config::github_app() else {
        return fail("not_configured");
    };
    let Some(state) = query.state.as_deref() else {
        return fail("invalid_state");
    };
    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(value)) => value,
        Ok(None) => return fail("invalid_state"),
        Err(e) => {
            error!(target: "auth", error = %e, "github app state lookup failed");
            return fail("server_error");
        }
    };
    let (Some(user_id), Some(org_id)) = (oauth_state.user_id, org_from_flow(&oauth_state.flow))
    else {
        return fail("invalid_state");
    };
    let Some(installation_id) = query
        .installation_id
        .as_deref()
        .and_then(|id| id.parse::<i64>().ok())
    else {
        return fail("missing_installation");
    };

    // Still the owner of that organization, judged from the database: a role
    // change between starting and finishing the install counts.
    match rbac::resolve_role_context(pool.get_ref(), user_id).await {
        Ok(ctx)
            if ctx.scope == Scope::Organization
                && ctx.role == Role::Owner
                && ctx.organization_id == Some(org_id) => {}
        Ok(_) => return fail("not_owner"),
        Err(e) => {
            error!(target: "auth", user_id, error = ?e, "github app owner check failed");
            return fail("server_error");
        }
    }

    // The person who came back must be able to see this installation, or anyone
    // could paste another account's installation id into this URL.
    let Some(code) = query.code.as_deref() else {
        return fail("missing_code");
    };
    let Some(user_token) = exchange_code(&cfg, code).await else {
        return fail("bad_code");
    };
    match user_can_see_installation(&user_token, installation_id).await {
        Ok(true) => {}
        Ok(false) => {
            warn!(target: "auth", user_id, org_id, installation_id,
                  "github app install rejected: installation not visible to the user");
            return fail("not_your_installation");
        }
        Err(()) => return fail("github_unreachable"),
    }

    let Some((account_login, account_type)) = installation_account(&cfg, installation_id).await
    else {
        return fail("github_unreachable");
    };

    // One installation serves one organization.
    let taken = sqlx::query_scalar::<_, i32>(
        "SELECT organization_id FROM github_installations
          WHERE installation_id = $1 AND organization_id <> $2",
    )
    .bind(installation_id)
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await;
    match taken {
        Ok(None) => {}
        Ok(Some(_)) => return fail("installation_in_use"),
        Err(e) => {
            error!(target: "db", error = ?e, "github installation lookup failed");
            return fail("server_error");
        }
    }

    let previous = org_installation(pool.get_ref(), org_id).await;
    let write = sqlx::query(
        "INSERT INTO github_installations
           (organization_id, installation_id, account_login, account_type, installed_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (organization_id) DO UPDATE SET
           installation_id = EXCLUDED.installation_id,
           account_login = EXCLUDED.account_login,
           account_type = EXCLUDED.account_type,
           installed_by = EXCLUDED.installed_by,
           updated_at = NOW()",
    )
    .bind(org_id)
    .bind(installation_id)
    .bind(&account_login)
    .bind(&account_type)
    .bind(user_id)
    .execute(pool.get_ref())
    .await;
    if let Err(e) = write {
        error!(target: "db", org_id, error = ?e, "github installation upsert failed");
        return fail("server_error");
    }
    if let Some((old_id, _, _)) = previous {
        INSTALLATION_TOKENS.invalidate(&old_id).await;
    }
    crate::github_proxy::invalidate_org_cache(org_id).await;

    info!(target: "auth", user_id, org_id, installation_id, account = %account_login,
          "github app installed for organization");
    back("github_app=connected")
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_app_status)
        .service(github_app_install)
        .service(github_app_disconnect)
        // Public, signed by GitHub: see github_app_webhook.
        .service(crate::github_app_webhook::github_app_webhook);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_app_setup);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_flow_round_trips_the_organization() {
        assert_eq!(org_from_flow(&install_flow(42)), Some(42));
    }

    #[test]
    fn other_flows_name_no_organization() {
        for flow in [
            "github_connect",
            "github_app_install",
            "github_app_install:",
            "github_app_installx:4",
            "github_app_install:abc",
        ] {
            assert_eq!(org_from_flow(flow), None, "{flow}");
        }
    }

    #[test]
    fn manage_url_depends_on_the_account_type() {
        assert!(
            manage_url(7, "acme", Some("Organization"))
                .ends_with("/organizations/acme/settings/installations/7")
        );
        assert!(manage_url(7, "alice", Some("User")).ends_with("/settings/installations/7"));
        assert!(!manage_url(7, "alice", Some("User")).contains("/organizations/"));
    }
}
