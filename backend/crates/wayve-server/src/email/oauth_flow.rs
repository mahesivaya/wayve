use crate::prelude::*;

use crate::email::account::{ConnectedEmailAccount, upsert_connected_email_account};
use crate::email::oauth::{HTTP_CLIENT, try_load_google_secrets};
use crate::email::provider::MailProvider;
use crate::email::sync::sync_account_recent;
use actix_web::{HttpResponse, Responder, web};
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::{auth_cookie, create_jwt_for_account};
use wayve_security::oauth::{consume_state, create_oauth_state};
use wayve_security::rbac;

/// Confirms the account exists before an external-mailbox connect. Any
/// authenticated account may connect its OWN mailbox — personal, organization
/// (including enterprise), or platform. The OAuth flow binds the mailbox to this
/// `user_id`, so a member only ever imports the address they signed in with;
/// there is no cross-user access. `Err(response)` is a ready-to-return 401 or
/// 500.
pub(crate) async fn require_external_mailbox_actor(
    pool: &PgPool,
    user_id: i32,
) -> Result<(), HttpResponse> {
    match rbac::resolve_role_context(pool, user_id).await {
        Ok(_) => Ok(()),
        Err(sqlx::Error::RowNotFound) => Err(HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Account not found" }))),
        Err(e) => {
            error!(target: "auth", error = ?e, user_id, "rbac role resolution failed for mailbox connect");
            Err(HttpResponse::InternalServerError().finish())
        }
    }
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginQuery {
    pub mode: Option<String>,
}

const OAUTH_FLOW_CONNECT: &str = "connect";
const OAUTH_FLOW_SIGNUP: &str = "signup";

fn google_redirect_uri(req: &HttpRequest, secrets: &Value) -> String {
    if let Some(uri) = crate::config::google_oauth().redirect_uri {
        return uri;
    }

    if let Some(base_url) = crate::config::backend_url() {
        let base_url = base_url.trim_end_matches('/');
        return format!("{base_url}/oauth/callback");
    }

    let connection = req.connection_info();
    let host = connection.host();
    if host.starts_with("localhost") || host.starts_with("127.0.0.1") || host.starts_with("[::1]") {
        return format!("{}://{host}/oauth/callback", connection.scheme());
    }

    secrets["web"]["redirect_uris"][0]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn google_oauth_url(client_id: &str, redirect_uri: &str, scope: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .unwrap_or_else(|err| panic!("valid Google OAuth URL: {err}"));
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", scope)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    url.to_string()
}

fn gmail_scope() -> &'static str {
    "https://www.googleapis.com/auth/userinfo.email \
     https://www.googleapis.com/auth/gmail.send \
     https://www.googleapis.com/auth/gmail.modify \
     https://www.googleapis.com/auth/gmail.readonly \
     https://www.googleapis.com/auth/calendar.readonly"
}

fn load_google_client() -> std::result::Result<Value, HttpResponse> {
    let secrets = match try_load_google_secrets() {
        Ok(value) => value,
        Err(e) => {
            error!(target: "gmail", error = %e, "google secrets unavailable");
            return Err(HttpResponse::InternalServerError().body("Google OAuth is not configured"));
        }
    };
    Ok(secrets)
}

#[derive(Serialize)]
pub struct GmailConnectUrlResponse {
    pub url: String,
}

fn google_client_id(secrets: &Value) -> std::result::Result<&str, HttpResponse> {
    let client_id = match secrets["web"]["client_id"].as_str() {
        Some(value) => value,
        None => {
            error!(target: "gmail", "client_id missing in google secrets");
            return Err(HttpResponse::InternalServerError().body("Google OAuth is not configured"));
        }
    };
    Ok(client_id)
}

#[instrument(target = "gmail", skip(req, pool))]
pub async fn gmail_connect_url(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let user_id = match wayve_security::jwt::get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            warn!(target: "gmail", "gmail connect-url rejected: missing token");
            return HttpResponse::Unauthorized().body("Missing token");
        }
    };

    if let Err(response) = require_external_mailbox_actor(pool.get_ref(), user_id).await {
        return response;
    }

    let secrets = match load_google_client() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let client_id = match google_client_id(&secrets) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let redirect_uri = google_redirect_uri(&req, &secrets);
    let state = match create_oauth_state(Some(user_id), OAUTH_FLOW_CONNECT, pool.get_ref()).await {
        Ok(state) => state,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth state store failed");
            return HttpResponse::InternalServerError().body("Failed to start OAuth flow");
        }
    };

    info!(target: "gmail", user_id, "gmail oauth connect flow start");
    let url = google_oauth_url(client_id, &redirect_uri, gmail_scope(), &state);
    HttpResponse::Ok().json(GmailConnectUrlResponse { url })
}

#[instrument(target = "gmail", skip(req, query, pool))]
pub async fn gmail_login(
    req: HttpRequest,
    query: web::Query<LoginQuery>,
    pool: web::Data<PgPool>,
) -> impl Responder {
    let secrets = match load_google_client() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let client_id = match google_client_id(&secrets) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let redirect_uri = google_redirect_uri(&req, &secrets);
    let is_signup = query.mode.as_deref() == Some("signup");

    let (user_id, flow) = if is_signup {
        (None, OAUTH_FLOW_SIGNUP)
    } else {
        let user_id = match wayve_security::jwt::get_user_id_from_request(&req) {
            Some(id) => id,
            None => {
                warn!(target: "gmail", "gmail_login rejected: missing token");
                return HttpResponse::Unauthorized().body("Missing token");
            }
        };

        // /gmail/login is the legacy redirect-based connect flow; keep it behind
        // the same actor check as POST /gmail/connect-url so both paths require a
        // real account.
        if let Err(response) = require_external_mailbox_actor(pool.get_ref(), user_id).await {
            return response;
        }

        (Some(user_id), OAUTH_FLOW_CONNECT)
    };

    let state = match create_oauth_state(user_id, flow, pool.get_ref()).await {
        Ok(state) => state,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth state store failed");
            return HttpResponse::InternalServerError().body("Failed to start OAuth flow");
        }
    };
    info!(target: "gmail", signup = is_signup, "gmail oauth flow start");

    let url = google_oauth_url(client_id, &redirect_uri, gmail_scope(), &state);

    HttpResponse::Found()
        .append_header(("Location", url))
        .finish()
}

#[instrument(target = "gmail", skip(pool, query))]
pub async fn oauth_callback(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<CallbackQuery>,
) -> impl Responder {
    let code = &query.code;
    let secrets = match try_load_google_secrets() {
        Ok(value) => value,
        Err(e) => {
            error!(target: "gmail", error = %e, "google secrets unavailable");
            return HttpResponse::InternalServerError().body("Google OAuth is not configured");
        }
    };

    let state = match &query.state {
        Some(t) => t,
        None => {
            warn!(target: "gmail", "oauth_callback rejected: missing state");
            return HttpResponse::Unauthorized().body("Missing state");
        }
    };

    let oauth_state = match consume_state(state, pool.get_ref()).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            warn!(target: "gmail", "oauth_callback rejected: invalid state");
            return HttpResponse::Unauthorized().body("Invalid OAuth state");
        }
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth state lookup failed");
            return HttpResponse::InternalServerError().body("Database error");
        }
    };

    let is_signup = oauth_state.flow == OAUTH_FLOW_SIGNUP;
    let mut user_id: i32 = match (is_signup, oauth_state.user_id) {
        (true, _) => 0,
        (false, Some(id)) => id,
        (false, None) => {
            warn!(target: "gmail", "oauth_callback rejected: connect state missing user");
            return HttpResponse::Unauthorized().body("Invalid OAuth state");
        }
    };
    info!(target: "gmail", user_id, signup = is_signup, "oauth_callback exchanging code");

    let (client_id, client_secret) = match (
        secrets["web"]["client_id"].as_str(),
        secrets["web"]["client_secret"].as_str(),
    ) {
        (Some(id), Some(secret)) => (id.to_string(), secret.to_string()),
        _ => {
            error!(target: "gmail", "client_id/client_secret missing in google secrets");
            return HttpResponse::InternalServerError().body("Google OAuth is not configured");
        }
    };
    let redirect_uri = google_redirect_uri(&req, &secrets);

    let token_response = match HTTP_CLIENT
        .post(crate::external::google_token_url())
        .form(&[
            ("code", code),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", &"authorization_code".to_string()),
        ])
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth token exchange request failed");
            return HttpResponse::BadGateway().body("Failed to reach Google");
        }
    };

    let res: Value = match token_response.json().await {
        Ok(value) => value,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth token response parse failed");
            return HttpResponse::BadGateway().body("Invalid response from Google");
        }
    };

    let access_token = res["access_token"].as_str().unwrap_or("");
    let refresh_token = res["refresh_token"].as_str().unwrap_or("");
    let expires_in = res["expires_in"].as_i64().unwrap_or(3600);

    let userinfo_response = match HTTP_CLIENT
        .get(crate::external::google_userinfo_url())
        .bearer_auth(access_token)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth userinfo request failed");
            return HttpResponse::BadGateway().body("Failed to reach Google");
        }
    };

    let user_info: Value = match userinfo_response.json().await {
        Ok(value) => value,
        Err(e) => {
            error!(target: "gmail", error = %e, "oauth userinfo response parse failed");
            return HttpResponse::BadGateway().body("Invalid response from Google");
        }
    };

    let email = user_info["email"].as_str().unwrap_or("");

    if email.is_empty() {
        warn!(target: "gmail", "oauth_callback: Google did not return an email");
        return HttpResponse::BadRequest().body("Google account did not expose an email address");
    }

    let frontend_for_errors = crate::config::frontend_url();
    // The signup flow doubles as the sign-in entry point, so `is_signup` alone
    // does not prove a new account. The frontend needs the real distinction,
    // passed as `&new=true`, to generate a keypair only for a genuinely new user.
    let mut was_new_user = false;
    if is_signup {
        let existing =
            sqlx::query("SELECT id, auth_provider, account_type FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(pool.get_ref())
                .await;

        match existing {
            Ok(Some(row)) => {
                let provider: String = row.get("auth_provider");
                if provider != "google" {
                    warn!(
                        target: "auth",
                        "Google signup blocked: {} already registered with {}",
                        email, provider
                    );
                    let redirect = format!("{}/login?error=email_exists", frontend_for_errors);
                    return HttpResponse::Found()
                        .append_header(("Location", redirect))
                        .finish();
                }
                user_id = row.get("id");
                info!(target: "auth", user_id, email, provider = "google", "sign-in via Google OAuth (existing user)");
            }
            Ok(None) => {
                let insert = sqlx::query(
                    "INSERT INTO users (email, password, auth_provider) \
                     VALUES ($1, NULL, 'google') RETURNING id",
                )
                .bind(email)
                .fetch_one(pool.get_ref())
                .await;

                match insert {
                    Ok(row) => {
                        user_id = row.get("id");
                        was_new_user = true;
                        info!(target: "auth", user_id, email, provider = "google", "user registered via Google OAuth");
                    }
                    Err(e) => {
                        error!(target: "auth", error = %e, "Google signup user insert failed");
                        return HttpResponse::InternalServerError()
                            .body("Failed to create account");
                    }
                }
            }
            Err(e) => {
                error!(target: "auth", error = %e, "Google signup user lookup failed");
                return HttpResponse::InternalServerError().body("Database error");
            }
        }
    }

    // Mailbox-match policy: a managed account (organization or platform) may
    // only connect the mailbox matching the address it logs into Fluxze with.
    // Only the connect flow is checked — a Google *signup* creates its account
    // from this same address, so it matches by construction. A policy-check DB
    // error fails closed.
    if !is_signup {
        match crate::email::account::account_may_attach_mailbox(pool.get_ref(), user_id, email)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                warn!(target: "gmail", user_id, "managed account mailbox connect rejected: authorized address does not match Fluxze login");
                return HttpResponse::Found()
                    .insert_header((
                        actix_web::http::header::LOCATION,
                        format!(
                            "{}/emails?error=mailbox_must_match_login",
                            frontend_for_errors
                        ),
                    ))
                    .finish();
            }
            Err(e) => {
                error!(target: "gmail", user_id, error = %e, "mailbox-match policy check failed; rejecting connect");
                return HttpResponse::Found()
                    .insert_header((
                        actix_web::http::header::LOCATION,
                        format!("{}/emails?error=mailbox_check_failed", frontend_for_errors),
                    ))
                    .finish();
            }
        }
    }

    // Cross-user mailbox guard: never attach a second copy of a mailbox already
    // owned by a different Wayve user. It must not block a login, though —
    // completing OAuth proves the caller owns the Google identity — so sign-in
    // logs them in and skips the conflicting mailbox, and only the explicit
    // connect flow gets the hard `email_in_use` rejection.
    let attach_mailbox = match crate::email::account::email_owned_by_other_user(
        pool.get_ref(),
        email,
        user_id,
    )
    .await
    {
        Ok(Some(other_user_id)) => {
            if is_signup {
                warn!(
                    target: "gmail",
                    email,
                    attempted_user = user_id,
                    existing_user = other_user_id,
                    "gmail owned by another user; signing in without (re)connecting the mailbox"
                );
                false
            } else {
                warn!(
                    target: "gmail",
                    email,
                    attempted_user = user_id,
                    existing_user = other_user_id,
                    "rejecting Gmail connect — already connected to another Wayve user"
                );
                let frontend = crate::config::frontend_url();
                return HttpResponse::Found()
                    .insert_header((
                        actix_web::http::header::LOCATION,
                        format!("{}/emails?error=email_in_use", frontend),
                    ))
                    .finish();
            }
        }
        Ok(None) => true,
        Err(e) => {
            error!(
                target: "gmail",
                error = %e,
                "duplicate-account precheck failed; failing open to existing upsert"
            );
            true
        }
    };

    if attach_mailbox {
        let account_id = match upsert_connected_email_account(
            pool.get_ref(),
            ConnectedEmailAccount {
                email,
                user_id,
                provider: MailProvider::Google,
                access_token,
                refresh_token: Some(refresh_token),
                expires_in,
            },
        )
        .await
        {
            Ok(id) => {
                info!(
                    "Gmail account connected: {} (user_id={}, account_id={})",
                    email, user_id, id
                );
                id
            }
            Err(e) => {
                error!("Failed to save Gmail account {}: {:?}", email, e);
                return HttpResponse::InternalServerError().body("Failed to save account");
            }
        };

        let pool_clone = pool.clone();
        let token_clone = access_token.to_string();
        actix_web::rt::spawn(async move {
            match sync_account_recent(pool_clone.get_ref(), account_id, &token_clone, 51).await {
                Ok(_) => info!(target: "gmail", user_id, account_id, "recent email sync primed"),
                Err(e) => {
                    warn!(target: "gmail", user_id, account_id, error = ?e, "recent email sync failed")
                }
            }
        });

        // Arm the Gmail watch so new mail pushes to Pub/Sub immediately.
        // Best-effort: the renewal worker re-arms it, and this is a no-op when
        // GMAIL_PUSH_TOPIC is unset.
        let watch_pool = pool.clone();
        let watch_token = access_token.to_string();
        actix_web::rt::spawn(async move {
            if let Err(e) = crate::email::gmail_push::start_watch(
                watch_pool.get_ref(),
                account_id,
                &watch_token,
            )
            .await
            {
                warn!(target: "gmail", user_id, account_id, error = ?e, "gmail watch arm failed");
            }
        });

        let pool_clone = pool.clone();
        let token_clone = access_token.to_string();
        actix_web::rt::spawn(async move {
            match crate::scheduler::google_calendar::import_upcoming_events(
                pool_clone.get_ref(),
                user_id,
                account_id,
                &token_clone,
            )
            .await
            {
                Ok(n) => {
                    info!(target: "scheduler", user_id, account_id, count = n, "calendar import done")
                }
                Err(e) => {
                    warn!(target: "scheduler", user_id, account_id, error = %e, "calendar import failed")
                }
            }
        });
    }

    info!(target: "gmail", user_id, signup = is_signup, "redirecting to frontend");

    let frontend = crate::config::frontend_url();

    let account_type: String = sqlx::query_scalar("SELECT account_type FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(pool.get_ref())
        .await
        .unwrap_or_else(|_| "personal".to_string());

    let redirect = if is_signup {
        let landing_path = if matches!(
            account_type.as_str(),
            "organization" | "organization_admin" | "platform_admin"
        ) {
            "organization-home"
        } else {
            "home"
        };
        if was_new_user {
            format!("{}/{landing_path}#signup=true&new=true", frontend)
        } else {
            format!("{}/{landing_path}#signup=true", frontend)
        }
    } else {
        format!("{}/emails#connected=true", frontend)
    };

    let mut response = HttpResponse::Found();
    response.append_header(("Location", redirect));

    if is_signup {
        let session_token = create_jwt_for_account(user_id, email.to_string(), account_type);
        response.cookie(auth_cookie(session_token));
        // Only this branch mints a session, so only it records a login to pair
        // with the logout audit event; the `else` branch is a mailbox connect.
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "login",
                resource_type: "session",
                resource_id: None,
                metadata: Some(serde_json::json!({
                    "method": "google",
                    "new_user": was_new_user,
                })),
            },
        )
        .await;
    }

    response.finish()
}
