//! Microsoft (Outlook) OAuth HTTP handlers.
//!
//! - sign-in:        `GET  /outlook/login?mode=signup`
//! - mailbox connect: `POST /api/outlook/connect-url` (authenticated)
//! - shared callback: `GET  /oauth/outlook/callback`
//!
//! Token exchange/refresh and Graph mailbox sync live in `email::outlook`.

use crate::prelude::*;

use crate::email::account::{ConnectedEmailAccount, upsert_connected_email_account};
use crate::email::outlook::{
    OUTLOOK_MAIL_SCOPE, OutlookCredentials, OutlookTokens, exchange_code, outlook_credentials,
    sync_outlook_account,
};
use crate::email::provider::MailProvider;
use wayve_security::jwt::{auth_cookie, create_jwt_for_account, get_user_id_from_request};
use wayve_security::oauth::{consume_state, create_oauth_state};
use actix_web::{HttpRequest, HttpResponse, Responder, web};
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};

/// OAuth `state` flow tags — distinct from the Google flows (and each other)
/// so a state minted for one purpose can't be replayed for another.
const OUTLOOK_FLOW_SIGNUP: &str = "outlook_signup";
const OUTLOOK_FLOW_CONNECT: &str = "outlook_connect";

#[derive(Deserialize)]
pub struct OutlookLoginQuery {
    pub mode: Option<String>,
}

#[derive(Deserialize)]
pub struct OutlookCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Serialize)]
pub struct OutlookConnectUrlResponse {
    pub url: String,
}

fn require_credentials() -> std::result::Result<OutlookCredentials, HttpResponse> {
    outlook_credentials().ok_or_else(|| {
        error!(
            target: "auth",
            "Outlook OAuth env vars missing (OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET / OUTLOOK_REDIRECT_URI)"
        );
        HttpResponse::InternalServerError().body("Outlook OAuth is not configured")
    })
}

fn authorize_url(creds: &OutlookCredentials, scope: &str, state: &str) -> String {
    let endpoint = format!(
        "{}/oauth2/v2.0/authorize",
        crate::external::microsoft_authority()
    );
    let mut url = reqwest::Url::parse(&endpoint)
        .unwrap_or_else(|err| panic!("valid Microsoft OAuth URL: {err}"));
    url.query_pairs_mut()
        .append_pair("client_id", &creds.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &creds.redirect_uri)
        .append_pair("response_mode", "query")
        .append_pair("scope", scope)
        // Force the consent screen so newly-added scopes are actually granted
        // instead of reusing a cached, narrower grant.
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    url.to_string()
}

/// Shared boilerplate to start an OAuth flow. Returns the provider consent URL
/// on success — the caller decides whether to 302 to it or return it as JSON.
async fn start_oauth_flow(
    pool: &PgPool,
    user_id: Option<i32>,
    flow_tag: &str,
    creds: &OutlookCredentials,
    scope: &str,
) -> std::result::Result<String, HttpResponse> {
    let state = create_oauth_state(user_id, flow_tag, pool)
        .await
        .map_err(|e| {
            error!(target: "auth", error = %e, flow = flow_tag, "oauth state store failed");
            HttpResponse::InternalServerError().body("Failed to start OAuth flow")
        })?;

    info!(target: "auth", flow = flow_tag, ?user_id, "oauth flow start");
    Ok(authorize_url(creds, scope, &state))
}

/// `GET /outlook/login?mode=signup` — kicks off Microsoft sign-in.
#[instrument(target = "auth", skip(query, pool))]
pub async fn outlook_login(
    query: web::Query<OutlookLoginQuery>,
    pool: web::Data<PgPool>,
) -> impl Responder {
    let creds = match require_credentials() {
        Ok(c) => c,
        Err(response) => return response,
    };
    if query.mode.as_deref() != Some("signup") {
        return HttpResponse::BadRequest()
            .body("Use POST /api/outlook/connect-url to connect a mailbox");
    }

    // Sign-in is a browser navigation — 302 straight to the consent screen.
    match start_oauth_flow(
        pool.get_ref(),
        None,
        OUTLOOK_FLOW_SIGNUP,
        &creds,
        OUTLOOK_MAIL_SCOPE,
    )
    .await
    {
        Ok(url) => HttpResponse::Found()
            .append_header(("Location", url))
            .finish(),
        Err(response) => response,
    }
}

/// `POST /api/outlook/connect-url` — returns the Microsoft consent URL for
/// connecting the signed-in user's Outlook mailbox.
#[instrument(target = "auth", skip(req, pool))]
pub async fn outlook_connect_url(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            warn!(target: "auth", "outlook connect-url rejected: missing token");
            return HttpResponse::Unauthorized().body("Missing token");
        }
    };

    if let Err(response) =
        crate::email::oauth_flow::require_external_mailbox_actor(pool.get_ref(), user_id).await
    {
        return response;
    }

    let creds = match require_credentials() {
        Ok(c) => c,
        Err(response) => return response,
    };

    // connect-url is fetched by the frontend — return the URL as JSON so it
    // can `window.location.href` to it (a 302 would be followed by fetch()).
    match start_oauth_flow(
        pool.get_ref(),
        Some(user_id),
        OUTLOOK_FLOW_CONNECT,
        &creds,
        OUTLOOK_MAIL_SCOPE,
    )
    .await
    {
        Ok(url) => HttpResponse::Ok().json(OutlookConnectUrlResponse { url }),
        Err(response) => response,
    }
}

/// `GET /oauth/outlook/callback` — shared callback for sign-in and mailbox
/// connect; the consumed `state.flow` decides which path runs.
#[instrument(target = "auth", skip(req, pool, query))]
pub async fn outlook_callback(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<OutlookCallbackQuery>,
) -> impl Responder {
    let creds = match require_credentials() {
        Ok(c) => c,
        Err(response) => return response,
    };

    let state = match &query.state {
        Some(s) => s,
        None => {
            warn!(target: "auth", "outlook_callback rejected: missing state");
            return HttpResponse::Unauthorized().body("Missing state");
        }
    };

    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            warn!(target: "auth", "outlook_callback rejected: invalid state");
            return HttpResponse::Unauthorized().body("Invalid OAuth state");
        }
        Err(e) => {
            error!(target: "auth", error = %e, "outlook oauth state lookup failed");
            return HttpResponse::InternalServerError().body("Database error");
        }
    };

    let is_connect = oauth_state.flow == OUTLOOK_FLOW_CONNECT;
    if !is_connect && oauth_state.flow != OUTLOOK_FLOW_SIGNUP {
        warn!(target: "auth", "outlook_callback rejected: unexpected flow");
        return HttpResponse::Unauthorized().body("Invalid OAuth state");
    }

    // Always exchange with the mail scope so a signed-in account can sync and
    // send immediately, not just on an explicit "connect mailbox".
    let tokens = match exchange_code(&creds, &query.code, OUTLOOK_MAIL_SCOPE).await {
        Ok(t) => t,
        Err(e) => {
            warn!(target: "auth", error = ?e, "outlook token exchange failed");
            return HttpResponse::BadGateway().body("Microsoft sign-in failed");
        }
    };

    let email = match graph_user_email(&tokens.access_token).await {
        Ok(email) => email,
        Err(response) => return response,
    };

    let frontend = crate::config::frontend_url();

    finalize_oauth_session(
        pool.get_ref(),
        &req,
        OAuthCompletion {
            session_user_id: oauth_state.user_id,
            email: &email,
            provider: "microsoft",
            tokens: &tokens,
            frontend: &frontend,
        },
    )
    .await
}

/// Bundles the OAuth-completion inputs — keeps `finalize_oauth_session` under
/// clippy's argument-count cap.
struct OAuthCompletion<'a> {
    session_user_id: Option<i32>,
    email: &'a str,
    provider: &'a str,
    tokens: &'a OutlookTokens,
    frontend: &'a str,
}

/// Unified finisher for OAuth callbacks.
///
/// If `session_user_id` is present, it links the mailbox to that user.
/// Otherwise, it performs a sign-in/sign-up for the identified email.
async fn finalize_oauth_session(
    pool: &PgPool,
    req: &HttpRequest,
    ctx: OAuthCompletion<'_>,
) -> HttpResponse {
    let (user_id, account_type): (i32, String) = match ctx.session_user_id {
        Some(id) => (id, "personal".to_string()),
        None => match resolve_user_for_oauth(pool, ctx.email, ctx.provider, ctx.frontend).await {
            Ok(result) => result,
            Err(response) => return response,
        },
    };

    // Cross-user duplicate gate — see `email_owned_by_other_user` for why.
    // Only applies when the caller already has a session (i.e. they're
    // *adding* an account); for fresh sign-up flows the user_id was just
    // created in `resolve_user_for_oauth` and uniqueness is implicit.
    if ctx.session_user_id.is_some() {
        match crate::email::account::email_owned_by_other_user(pool, ctx.email, user_id).await {
            Ok(Some(other_user_id)) => {
                warn!(
                    target: "auth",
                    email = ctx.email,
                    attempted_user = user_id,
                    existing_user = other_user_id,
                    provider = ctx.provider,
                    "rejecting OAuth connect — already connected to another Wayve user"
                );
                return HttpResponse::Found()
                    .append_header((
                        "Location",
                        format!("{}/emails?error=email_in_use", ctx.frontend),
                    ))
                    .finish();
            }
            Ok(None) => {}
            Err(e) => {
                error!(
                    target: "auth",
                    error = %e,
                    "duplicate-account precheck failed; falling through to upsert"
                );
            }
        }
    }

    match upsert_email_account(pool, user_id, ctx.email, ctx.tokens).await {
        Ok(account_id) => {
            info!(target: "auth", user_id, account_id, provider = ctx.provider, "mailbox linked");
        }
        Err(e) => {
            error!(target: "auth", user_id, error = %e, provider = ctx.provider, "mailbox link failed");
            if ctx.session_user_id.is_some() {
                return HttpResponse::InternalServerError().body("Failed to save account");
            }
        }
    }

    if ctx.session_user_id.is_some() {
        HttpResponse::Found()
            .append_header((
                "Location",
                format!("{}/emails#connected=true", ctx.frontend),
            ))
            .finish()
    } else {
        let token = create_jwt_for_account(user_id, ctx.email.to_string(), account_type.clone());
        let landing = if matches!(
            account_type.as_str(),
            "organization" | "organization_admin" | "platform_admin"
        ) {
            "organization-home"
        } else {
            "home"
        };
        // App sign-in via Microsoft mints a session here (the `if` branch above
        // is a mailbox connect for an already-logged-in user). Record the login
        // so it pairs with the logout audit event.
        crate::audit::record_action(
            pool,
            req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "login",
                resource_type: "session",
                resource_id: None,
                metadata: Some(serde_json::json!({ "method": "microsoft" })),
            },
        )
        .await;
        HttpResponse::Found()
            .cookie(auth_cookie(token))
            .append_header((
                "Location",
                format!("{}/{landing}#signup=true", ctx.frontend),
            ))
            .finish()
    }
}

/// Resolves an OAuth identity to a local user ID.
async fn resolve_user_for_oauth(
    pool: &PgPool,
    email: &str,
    provider: &str,
    frontend: &str,
) -> std::result::Result<(i32, String), HttpResponse> {
    let existing =
        sqlx::query("SELECT id, auth_provider, account_type FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(pool)
            .await;

    let (user_id, account_type): (i32, String) = match existing {
        Ok(Some(row)) => {
            let provider: String = row.get("auth_provider");
            if provider != "microsoft" && provider != "google" {
                warn!(
                    target: "auth",
                    "OAuth sign-in blocked: {email} already registered with {provider}"
                );
                return Err(HttpResponse::Found()
                    .append_header(("Location", format!("{frontend}/login?error=email_exists")))
                    .finish());
            }
            (row.get("id"), row.get("account_type"))
        }
        Ok(None) => {
            match sqlx::query(
                "INSERT INTO users (username, email, password, auth_provider) \
                 VALUES ($1, $2, NULL, $3) RETURNING id, account_type",
            )
            .bind(email)
            .bind(email)
            .bind(provider)
            .fetch_one(pool)
            .await
            {
                Ok(row) => (row.get("id"), row.get("account_type")),
                Err(e) => {
                    error!(target: "auth", error = %e, provider, "OAuth signup user insert failed");
                    return Err(
                        HttpResponse::InternalServerError().body("Failed to create account")
                    );
                }
            }
        }
        Err(e) => {
            error!(target: "auth", error = %e, provider, "OAuth sign-in user lookup failed");
            return Err(HttpResponse::InternalServerError().body("Database error"));
        }
    };
    Ok((user_id, account_type))
}

/// Normalizes a Microsoft guest UPN (e.g. `user_gmail.com#ext#@tenant...`)
/// back into a clean address (`user@gmail.com`).
fn sanitize_microsoft_email(raw: &str) -> String {
    let email = raw.trim().to_lowercase();
    if !email.contains("#ext#") {
        return email;
    }
    if let Some(prefix) = email.split('#').next()
        && let Some(idx) = prefix.rfind('_')
    {
        let (local, domain_part) = prefix.split_at(idx);
        if domain_part.len() > 1 {
            let clean_domain = &domain_part[1..];
            if clean_domain.contains('.') {
                return format!("{local}@{clean_domain}");
            }
        }
    }
    email
}

/// Reads the signed-in user's primary email from Microsoft Graph `/me`.
async fn graph_user_email(access_token: &str) -> std::result::Result<String, HttpResponse> {
    let url = format!("{}/v1.0/me", crate::external::microsoft_graph_base());
    let me: Value = match crate::email::oauth::HTTP_CLIENT
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
    {
        Ok(resp) => match resp.json().await {
            Ok(value) => value,
            Err(e) => {
                error!(target: "auth", error = %e, "outlook graph /me parse failed");
                return Err(HttpResponse::BadGateway().body("Invalid response from Microsoft"));
            }
        },
        Err(e) => {
            error!(target: "auth", error = %e, "outlook graph /me request failed");
            return Err(HttpResponse::BadGateway().body("Failed to reach Microsoft"));
        }
    };

    let raw_email = me["mail"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            me["otherMails"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
        })
        .or_else(|| me["userPrincipalName"].as_str())
        .unwrap_or_default();

    let email = sanitize_microsoft_email(raw_email);
    if email.is_empty() {
        warn!(target: "auth", "outlook_callback: Microsoft did not return an email");
        return Err(
            HttpResponse::BadRequest().body("Microsoft account did not expose an email address")
        );
    }
    Ok(email)
}

/// Upserts the `email_accounts` row for an Outlook mailbox and primes an
/// initial Graph sync. Microsoft rotates refresh tokens, so an empty new
/// refresh token keeps the previously-stored one.
async fn upsert_email_account(
    pool: &PgPool,
    user_id: i32,
    email: &str,
    tokens: &OutlookTokens,
) -> Result<i32> {
    let account_id = upsert_connected_email_account(
        pool,
        ConnectedEmailAccount {
            email,
            user_id,
            provider: MailProvider::Microsoft,
            access_token: &tokens.access_token,
            refresh_token: tokens.refresh_token.as_deref(),
            expires_in: tokens.expires_in,
        },
    )
    .await?;

    // Prime an initial sync without blocking the redirect.
    let pool = pool.clone();
    let access_token = tokens.access_token.clone();
    actix_web::rt::spawn(async move {
        if let Err(e) = sync_outlook_account(&pool, account_id, &access_token, None).await {
            warn!(target: "worker", account_id, error = ?e, "initial outlook sync failed");
        }
    });

    Ok(account_id)
}
