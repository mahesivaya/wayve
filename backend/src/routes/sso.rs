//! SSO admin endpoints + the public OIDC auth flow (start + callback).
//!
//! Admin surface (gated by `sso:manage` + organization access):
//!   GET    /api/organizations/{id}/sso/config   — fetch this org's config
//!   PUT    /api/organizations/{id}/sso/config   — create or replace
//!   DELETE /api/organizations/{id}/sso/config   — remove
//!   POST   /api/organizations/{id}/sso/test     — dry-run IdP discovery
//!
//! Public surface (no auth — kicks off the redirect dance):
//!   GET    /api/auth/sso/start?email=...        — 302 to the IdP authorize URL
//!   GET    /api/auth/sso/callback?code=...&state=...
//!                                               — exchange + verify + JIT,
//!                                                 sets the session cookie,
//!                                                 302s into the app
//!
//! JIT provisioning rules (see [resolve_or_provision_user]):
//!   1. If a user already has `(sso_org_id, sso_sub) = (org, sub)`, sign them in.
//!   2. Otherwise, if a user with the IdP-returned email exists in the org,
//!      link them by setting sso_sub + sso_org_id.
//!   3. Otherwise, create a new `users` row + `organization_members` row
//!      with role `member`. Requires `email_verified=true` on the id_token.

use crate::prelude::*;
use crate::security::encryption::{decrypt, encrypt};
use crate::security::jwt::{auth_cookie, create_jwt_for_account};
use crate::security::rbac::{self, Permission};
use crate::security::sso::{
    IdTokenClaims, build_authorize_url, discovery, exchange_code, pkce_challenge_s256,
    random_token, verify_id_token,
};
use actix_web::{HttpRequest, HttpResponse, delete, get, post, put, web};
use chrono::{DateTime, Utc};
use tracing::{info, instrument, warn};

// =============================================================
// Shared DTOs / row types
// =============================================================

#[derive(Debug, Deserialize)]
pub struct SsoConfigInput {
    pub issuer_url: String,
    pub client_id: String,
    /// Optional on update — omit to keep the existing secret.
    pub client_secret: Option<String>,
    pub allowed_domain: String,
    #[serde(default)]
    pub enforce_sso: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Serialize, FromRow)]
pub struct SsoConfigView {
    pub id: i32,
    pub organization_id: i32,
    pub issuer_url: String,
    pub client_id: String,
    pub allowed_domain: String,
    pub enforce_sso: bool,
    pub enabled: bool,
    /// The redirect_uri the org should register at their IdP. Derived
    /// server-side so the UI can copy-paste it instead of guessing.
    pub redirect_uri: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct SsoConfigRow {
    id: i32,
    organization_id: i32,
    issuer_url: String,
    client_id: String,
    client_secret_iv: String,
    client_secret_encrypted: String,
    allowed_domain: String,
    enforce_sso: bool,
    enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl SsoConfigRow {
    fn into_view(self) -> SsoConfigView {
        SsoConfigView {
            id: self.id,
            organization_id: self.organization_id,
            issuer_url: self.issuer_url,
            client_id: self.client_id,
            allowed_domain: self.allowed_domain,
            enforce_sso: self.enforce_sso,
            enabled: self.enabled,
            redirect_uri: callback_redirect_uri(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

// =============================================================
// Helpers
// =============================================================

/// The single redirect URI Wayve uses for every IdP. Customers register
/// this exact string at their IdP console.
fn callback_redirect_uri() -> String {
    format!("{}/api/auth/sso/callback", crate::config::frontend_url())
}

fn normalize_domain(input: &str) -> String {
    input.trim().trim_start_matches('@').to_ascii_lowercase()
}

fn extract_domain(email: &str) -> Option<String> {
    let (_, domain) = email.split_once('@')?;
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        None
    } else {
        Some(domain)
    }
}

fn validate_input(input: &SsoConfigInput, secret_required: bool) -> Result<(), HttpResponse> {
    let issuer = input.issuer_url.trim();
    if !(issuer.starts_with("https://") || issuer.starts_with("http://localhost")) {
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "issuer_url must be https:// (http://localhost is allowed for dev)"
        })));
    }
    if input.client_id.trim().is_empty() {
        return Err(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "client_id is required" })));
    }
    if secret_required
        && input
            .client_secret
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
    {
        return Err(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "client_secret is required" })));
    }
    let domain = normalize_domain(&input.allowed_domain);
    if domain.is_empty() || !domain.contains('.') {
        return Err(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "allowed_domain must look like 'acme.com'" })));
    }
    Ok(())
}

async fn load_config_by_org(
    pool: &PgPool,
    organization_id: i32,
) -> sqlx::Result<Option<SsoConfigRow>> {
    sqlx::query_as::<_, SsoConfigRow>(
        "SELECT id, organization_id, issuer_url, client_id, client_secret_iv, client_secret_encrypted,
                allowed_domain, enforce_sso, enabled, created_at, updated_at
           FROM org_sso_configs
          WHERE organization_id = $1",
    )
    .bind(organization_id)
    .fetch_optional(pool)
    .await
}

async fn load_config_by_domain(pool: &PgPool, domain: &str) -> sqlx::Result<Option<SsoConfigRow>> {
    sqlx::query_as::<_, SsoConfigRow>(
        "SELECT id, organization_id, issuer_url, client_id, client_secret_iv, client_secret_encrypted,
                allowed_domain, enforce_sso, enabled, created_at, updated_at
           FROM org_sso_configs
          WHERE allowed_domain = $1 AND enabled = TRUE",
    )
    .bind(domain)
    .fetch_optional(pool)
    .await
}

async fn load_config_by_id(pool: &PgPool, id: i32) -> sqlx::Result<Option<SsoConfigRow>> {
    sqlx::query_as::<_, SsoConfigRow>(
        "SELECT id, organization_id, issuer_url, client_id, client_secret_iv, client_secret_encrypted,
                allowed_domain, enforce_sso, enabled, created_at, updated_at
           FROM org_sso_configs
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

fn decrypt_secret(row: &SsoConfigRow) -> Result<String, HttpResponse> {
    decrypt(&row.client_secret_iv, &row.client_secret_encrypted).map_err(|e| {
        warn!(target: "auth", error = %e, "SSO client_secret decrypt failed");
        HttpResponse::InternalServerError()
            .json(serde_json::json!({ "message": "Failed to read SSO secret" }))
    })
}

// =============================================================
// Admin: GET /api/organizations/{id}/sso/config
// =============================================================

#[get("/organizations/{org_id}/sso/config")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn get_sso_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let org_id = path.into_inner();
    if let Err(resp) =
        rbac::require_org_access(&req, pool.get_ref(), org_id, Permission::SsoManage).await
    {
        return Ok(resp);
    }
    let row = match load_config_by_org(pool.get_ref(), org_id).await? {
        Some(row) => row,
        None => {
            return Ok(HttpResponse::NotFound().json(serde_json::json!({
                "message": "No SSO config for this organization"
            })));
        }
    };
    Ok(HttpResponse::Ok().json(row.into_view()))
}

// =============================================================
// Admin: PUT /api/organizations/{id}/sso/config (upsert)
// =============================================================

#[put("/organizations/{org_id}/sso/config")]
#[instrument(target = "auth", skip(req, pool, path, body))]
pub async fn upsert_sso_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<SsoConfigInput>,
) -> AppResult {
    let org_id = path.into_inner();
    if let Err(resp) =
        rbac::require_org_access(&req, pool.get_ref(), org_id, Permission::SsoManage).await
    {
        return Ok(resp);
    }

    let existing = load_config_by_org(pool.get_ref(), org_id).await?;
    let secret_required = existing.is_none();
    if let Err(resp) = validate_input(&body, secret_required) {
        return Ok(resp);
    }

    let issuer = body.issuer_url.trim().trim_end_matches('/').to_string();
    let client_id = body.client_id.trim().to_string();
    let domain = normalize_domain(&body.allowed_domain);

    // Encrypt the secret if provided; otherwise keep the existing
    // ciphertext (PUT acts as a partial update for the secret only).
    let (iv, ciphertext) = match (&body.client_secret, existing.as_ref()) {
        (Some(raw), _) if !raw.trim().is_empty() => encrypt(raw.trim()).map_err(|e| {
            warn!(target: "auth", error = %e, "encrypt failed");
            AppError::Internal("Failed to store secret".into())
        })?,
        (_, Some(prev)) => (
            prev.client_secret_iv.clone(),
            prev.client_secret_encrypted.clone(),
        ),
        (_, None) => unreachable!("secret_required forces this branch above"),
    };

    let row = sqlx::query_as::<_, SsoConfigRow>(
        r#"
        INSERT INTO org_sso_configs (
            organization_id, issuer_url, client_id,
            client_secret_iv, client_secret_encrypted,
            allowed_domain, enforce_sso, enabled, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (organization_id) DO UPDATE SET
            issuer_url = EXCLUDED.issuer_url,
            client_id = EXCLUDED.client_id,
            client_secret_iv = EXCLUDED.client_secret_iv,
            client_secret_encrypted = EXCLUDED.client_secret_encrypted,
            allowed_domain = EXCLUDED.allowed_domain,
            enforce_sso = EXCLUDED.enforce_sso,
            enabled = EXCLUDED.enabled,
            updated_at = NOW()
        RETURNING id, organization_id, issuer_url, client_id, client_secret_iv,
                  client_secret_encrypted, allowed_domain, enforce_sso, enabled,
                  created_at, updated_at
        "#,
    )
    .bind(org_id)
    .bind(&issuer)
    .bind(&client_id)
    .bind(&iv)
    .bind(&ciphertext)
    .bind(&domain)
    .bind(body.enforce_sso)
    .bind(body.enabled)
    .fetch_one(pool.get_ref())
    .await?;

    info!(
        target: "auth",
        organization_id = org_id,
        issuer = %issuer,
        domain = %domain,
        "SSO config upserted"
    );
    Ok(HttpResponse::Ok().json(row.into_view()))
}

// =============================================================
// Admin: DELETE /api/organizations/{id}/sso/config
// =============================================================

#[delete("/organizations/{org_id}/sso/config")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn delete_sso_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let org_id = path.into_inner();
    if let Err(resp) =
        rbac::require_org_access(&req, pool.get_ref(), org_id, Permission::SsoManage).await
    {
        return Ok(resp);
    }
    let deleted = sqlx::query("DELETE FROM org_sso_configs WHERE organization_id = $1")
        .bind(org_id)
        .execute(pool.get_ref())
        .await?
        .rows_affected();
    if deleted == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "No SSO config to delete" })));
    }
    Ok(HttpResponse::NoContent().finish())
}

// =============================================================
// Admin: POST /api/organizations/{id}/sso/test
// =============================================================

#[derive(Serialize)]
struct SsoTestResult {
    pub ok: bool,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    pub redirect_uri: String,
}

#[post("/organizations/{org_id}/sso/test")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn test_sso_config(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let org_id = path.into_inner();
    if let Err(resp) =
        rbac::require_org_access(&req, pool.get_ref(), org_id, Permission::SsoManage).await
    {
        return Ok(resp);
    }
    let row = match load_config_by_org(pool.get_ref(), org_id).await? {
        Some(row) => row,
        None => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "No SSO config to test" })));
        }
    };
    let doc = match discovery(&row.issuer_url).await {
        Ok(doc) => doc,
        Err(e) => {
            warn!(target: "auth", error = %e, issuer = %row.issuer_url, "SSO discovery test failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "ok": false,
                "message": format!("Discovery failed: {e}"),
            })));
        }
    };
    Ok(HttpResponse::Ok().json(SsoTestResult {
        ok: true,
        issuer: doc.issuer.clone(),
        authorization_endpoint: doc.authorization_endpoint.clone(),
        token_endpoint: doc.token_endpoint.clone(),
        jwks_uri: doc.jwks_uri.clone(),
        redirect_uri: callback_redirect_uri(),
    }))
}

// =============================================================
// Public: GET /api/auth/sso/start?email=alice@acme.com
// =============================================================

#[derive(Deserialize)]
pub struct SsoStartQuery {
    pub email: String,
    /// Optional path inside the SPA to land on after sign-in.
    pub return_to: Option<String>,
}

#[get("/auth/sso/start")]
#[instrument(target = "auth", skip(pool, q))]
pub async fn auth_sso_start(pool: web::Data<PgPool>, q: web::Query<SsoStartQuery>) -> AppResult {
    let domain = match extract_domain(&q.email) {
        Some(d) => d,
        None => {
            return Ok(
                HttpResponse::BadRequest().json(serde_json::json!({ "message": "Invalid email" }))
            );
        }
    };
    let row = match load_config_by_domain(pool.get_ref(), &domain).await? {
        Some(row) => row,
        None => {
            return Ok(HttpResponse::NotFound().json(serde_json::json!({
                "message": "No SSO is configured for this email domain",
                "code": "sso_not_configured"
            })));
        }
    };

    let doc = match discovery(&row.issuer_url).await {
        Ok(doc) => doc,
        Err(e) => {
            warn!(target: "auth", error = %e, "SSO discovery failed during start");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Identity provider is unreachable"
            })));
        }
    };

    let state = random_token();
    let nonce = random_token();
    let verifier = random_token();
    let challenge = pkce_challenge_s256(&verifier);

    sqlx::query(
        "INSERT INTO sso_states (state, sso_config_id, pkce_verifier, nonce, return_to)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&state)
    .bind(row.id)
    .bind(&verifier)
    .bind(&nonce)
    .bind(q.return_to.as_deref())
    .execute(pool.get_ref())
    .await?;

    let url = match build_authorize_url(
        &doc,
        &row.client_id,
        &callback_redirect_uri(),
        &state,
        &nonce,
        &challenge,
        Some(&q.email),
    ) {
        Ok(url) => url,
        Err(e) => {
            warn!(target: "auth", error = %e, "SSO authorize URL build failed");
            return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                "message": "Failed to build authorize URL"
            })));
        }
    };

    Ok(HttpResponse::Found()
        .append_header(("Location", url))
        .finish())
}

// =============================================================
// Public: GET /api/auth/sso/callback?code=...&state=...
// =============================================================

#[derive(Deserialize)]
pub struct SsoCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[get("/auth/sso/callback")]
#[instrument(target = "auth", skip(pool, q))]
pub async fn auth_sso_callback(
    pool: web::Data<PgPool>,
    q: web::Query<SsoCallbackQuery>,
) -> AppResult {
    if let Some(err) = &q.error {
        let desc = q.error_description.as_deref().unwrap_or("");
        warn!(target: "auth", err = %err, desc = %desc, "IdP returned error");
        return Ok(redirect_with_error(&format!("sso_error={}", err)));
    }
    let (Some(code), Some(state)) = (q.code.as_deref(), q.state.as_deref()) else {
        return Ok(redirect_with_error("sso_error=missing_code"));
    };

    // Consume the state row (DELETE … RETURNING — single-use). If it's
    // already gone, expired, or never existed, abort. This is the only
    // thing standing between us and CSRF/replay; treat it as critical.
    let row = sqlx::query_as::<_, sso_state_row::Row>(
        "DELETE FROM sso_states
          WHERE state = $1 AND expires_at > NOW()
         RETURNING sso_config_id, pkce_verifier, nonce, return_to",
    )
    .bind(state)
    .fetch_optional(pool.get_ref())
    .await?;
    let state_row = match row {
        Some(row) => row,
        None => return Ok(redirect_with_error("sso_error=invalid_state")),
    };

    let cfg = match load_config_by_id(pool.get_ref(), state_row.sso_config_id).await? {
        Some(cfg) => cfg,
        None => return Ok(redirect_with_error("sso_error=config_missing")),
    };
    let client_secret = match decrypt_secret(&cfg) {
        Ok(s) => s,
        Err(resp) => return Ok(resp),
    };

    let doc = match discovery(&cfg.issuer_url).await {
        Ok(doc) => doc,
        Err(e) => {
            warn!(target: "auth", error = %e, "SSO discovery failed during callback");
            return Ok(redirect_with_error("sso_error=discovery_failed"));
        }
    };

    let id_token = match exchange_code(
        &doc,
        &cfg.client_id,
        &client_secret,
        &callback_redirect_uri(),
        code,
        &state_row.pkce_verifier,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            warn!(target: "auth", error = %e, "SSO token exchange failed");
            return Ok(redirect_with_error("sso_error=token_exchange_failed"));
        }
    };

    let claims = match verify_id_token(&id_token, &doc, &cfg.client_id, &state_row.nonce).await {
        Ok(c) => c,
        Err(e) => {
            warn!(target: "auth", error = %e, "id_token verification failed");
            return Ok(redirect_with_error("sso_error=id_token_invalid"));
        }
    };

    // JIT provisioning happens here.
    let (user_id, email, account_type, is_new) =
        match resolve_or_provision_user(pool.get_ref(), &cfg, &claims).await {
            Ok(t) => t,
            Err(msg) => {
                warn!(target: "auth", "JIT provisioning failed: {msg}");
                return Ok(redirect_with_error(&format!(
                    "sso_error=provisioning_failed&detail={}",
                    urlencode(&msg)
                )));
            }
        };

    let token = create_jwt_for_account(user_id, email.clone(), account_type.clone());
    let cookie = auth_cookie(token.clone());

    // Land on the user's account home with the token in the URL fragment.
    // The AuthContext bootstrap reads `#token=...&sso=true` and hydrates the
    // session — same mechanism the Google/Outlook OAuth flow uses with
    // `&signup=true`. Hash never reaches a server, so the token isn't
    // logged. `return_to` is restricted to absolute in-app paths to block
    // open-redirect abuse.
    let return_to = state_row
        .return_to
        .as_deref()
        .filter(|rt| rt.starts_with('/') && !rt.starts_with("//"))
        .map(|rt| rt.to_string())
        .unwrap_or_else(|| {
            if matches!(
                account_type.as_str(),
                "organization" | "organization_admin" | "platform_admin"
            ) {
                "/organization-home".to_string()
            } else {
                "/home".to_string()
            }
        });
    let location = format!(
        "{}{}#sso=true&new={}&token={}",
        crate::config::frontend_url(),
        return_to,
        is_new,
        urlencode(&token),
    );

    info!(
        target: "auth",
        user_id,
        is_new,
        organization_id = cfg.organization_id,
        "SSO login complete"
    );

    Ok(HttpResponse::Found()
        .append_header(("Location", location))
        .cookie(cookie)
        .finish())
}

/// Minimal application/x-www-form-urlencoded encoder for the bits that
/// land in a URL fragment after the SSO callback. We control the input
/// (it's our own JWT or a short error code), so this stays small.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match *byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn redirect_with_error(fragment: &str) -> HttpResponse {
    let location = format!("{}/login#{fragment}", crate::config::frontend_url());
    HttpResponse::Found()
        .append_header(("Location", location))
        .finish()
}

// =============================================================
// JIT provisioning
// =============================================================

/// Returns `(user_id, email, account_type, is_new)`.
async fn resolve_or_provision_user(
    pool: &PgPool,
    cfg: &SsoConfigRow,
    claims: &IdTokenClaims,
) -> std::result::Result<(i32, String, String, bool), String> {
    let email = claims
        .email
        .as_deref()
        .ok_or("id_token missing email claim")?
        .trim()
        .to_ascii_lowercase();
    if email.is_empty() {
        return Err("id_token email is empty".into());
    }

    // Domain guard: prevents alice@evil.com from sneaking into Acme via
    // Acme's IdP if the IdP allows guest accounts from outside its primary
    // domain (Google Workspace can do this).
    let domain = extract_domain(&email).ok_or("invalid email format")?;
    if domain != cfg.allowed_domain {
        return Err(format!(
            "Email domain {domain} does not match the org's SSO domain {}",
            cfg.allowed_domain
        ));
    }

    // 1. Existing SSO identity → sign in.
    if let Some(row) = sqlx::query_as::<_, IdRow>(
        "SELECT id, account_type FROM users WHERE sso_org_id = $1 AND sso_sub = $2",
    )
    .bind(cfg.organization_id)
    .bind(&claims.sub)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("db error: {e}"))?
    {
        return Ok((row.id, email, row.account_type, false));
    }

    // 2. Email match within the org → link the SSO identity.
    if let Some(row) =
        sqlx::query_as::<_, IdRow>("SELECT id, account_type FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("db error: {e}"))?
    {
        // Require email_verified before linking — without this an attacker
        // could provision an IdP account claiming any email and silently
        // take over an existing Wayve user.
        if !claims.email_verified.unwrap_or(false) {
            return Err("IdP did not assert email_verified=true; refusing link".into());
        }
        sqlx::query(
            "UPDATE users SET sso_sub = $1, sso_org_id = $2, organization_id = $2 WHERE id = $3",
        )
        .bind(&claims.sub)
        .bind(cfg.organization_id)
        .bind(row.id)
        .execute(pool)
        .await
        .map_err(|e| format!("db error: {e}"))?;
        ensure_org_member(pool, cfg.organization_id, row.id).await?;
        return Ok((row.id, email, row.account_type, false));
    }

    // 3. New user — JIT provisioning. Requires email_verified.
    if !claims.email_verified.unwrap_or(false) {
        return Err("IdP did not assert email_verified=true; refusing to create user".into());
    }
    let display_name = claims
        .name
        .clone()
        .or_else(
            || match (claims.given_name.as_deref(), claims.family_name.as_deref()) {
                (Some(g), Some(f)) => Some(format!("{g} {f}")),
                (Some(g), None) => Some(g.to_string()),
                (None, Some(f)) => Some(f.to_string()),
                _ => None,
            },
        )
        .unwrap_or_else(|| email.clone());

    let new_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO users
            (email, username, first_name, password, auth_provider, account_type,
             organization_id, sso_org_id, sso_sub)
        VALUES ($1, $2, $3, NULL, 'sso', 'organization', $4, $4, $5)
        RETURNING id
        "#,
    )
    .bind(&email)
    .bind(&email) // username defaults to email — same as the existing OAuth flow
    .bind(&display_name)
    .bind(cfg.organization_id)
    .bind(&claims.sub)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("db error inserting user: {e}"))?;

    ensure_org_member(pool, cfg.organization_id, new_id).await?;
    Ok((new_id, email, "organization".to_string(), true))
}

async fn ensure_org_member(
    pool: &PgPool,
    organization_id: i32,
    user_id: i32,
) -> std::result::Result<(), String> {
    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (organization_id, user_id) DO NOTHING",
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|e| format!("db error inserting org member: {e}"))
}

#[derive(FromRow)]
struct IdRow {
    id: i32,
    account_type: String,
}

mod sso_state_row {
    use super::*;
    #[derive(FromRow)]
    pub struct Row {
        pub sso_config_id: i32,
        pub pkce_verifier: String,
        pub nonce: String,
        pub return_to: Option<String>,
    }
}
