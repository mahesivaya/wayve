use dotenvy::dotenv;
use std::env;
use tracing::{info, warn};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeRole {
    Api,
    EmailSyncWorker,
    EmailBodyWorker,
    All,
}

impl RuntimeRole {
    pub fn from_env() -> Self {
        match env::var("RWAYVE_ROLE").as_deref() {
            Ok("email-sync-worker") => Self::EmailSyncWorker,
            Ok("email-body-worker") => Self::EmailBodyWorker,
            Ok("all") => Self::All,
            _ => Self::Api,
        }
    }
}

pub fn load_env_files() {
    dotenv().ok();

    if let Ok(env_file) = env::var("ENV_FILE") {
        dotenvy::from_filename_override(env_file).ok();
    }

    let app_env = env::var("RWAYVE_ENV")
        .or_else(|_| env::var("ENV"))
        .unwrap_or_else(|_| "development".to_string());
    dotenvy::from_filename_override(format!(".env.{app_env}")).ok();
    dotenvy::from_filename_override(format!("backend/.env.{app_env}")).ok();
    dotenvy::from_filename("backend/.env").ok();

    // The single source of truth for credentials, keys, and the DB connection
    // string. Must load last so it wins over any stale key in the files above.
    // Absent from docker images; containers get it via the `env_file:` directive.
    dotenvy::from_filename_override(".env.secrets").ok();
}

pub fn db_max_connections(role: RuntimeRole) -> u32 {
    // Role policy is a server concern and stays here; the env override and parse
    // handling live in wayve-db.
    let default = match role {
        RuntimeRole::Api | RuntimeRole::All => 50,
        RuntimeRole::EmailSyncWorker | RuntimeRole::EmailBodyWorker => 5,
    };
    wayve_db::config::database_max_connections(default)
}

pub fn listen_port() -> u16 {
    env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080)
}

/// Resolve the Postgres connection string. An explicit `DATABASE_URL` wins
/// (docker-compose, CI, and prod set it); otherwise it is derived from the
/// `POSTGRES_*` parts so credentials live exactly once, in `.env.secrets`.
pub fn database_url() -> String {
    wayve_db::config::database_url()
}

// Every environment-specific value goes through this module, or `external.rs` for
// external endpoint URLs. Accessors read the process env on each call so that
// env-mutating tests keep working. To add a setting, add an accessor here plus an
// entry in ENVIRONMENTS.md, and never call `env::var` elsewhere.

/// An env var, trimmed; `None` when unset or blank.
fn var_opt(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// An env var, trimmed, with a fallback default.
fn var_or(key: &str, default: &str) -> String {
    var_opt(key).unwrap_or_else(|| default.to_string())
}

/// Recipient and calendar organizer for "Book a demo" notifications.
pub fn demo_notify_email() -> String {
    var_or("DEMO_NOTIFY_EMAIL", "maheshiv199@gmail.com")
}

/// Recipient for "new pull request opened" notifications.
pub fn github_pr_notify_email() -> String {
    var_or("GITHUB_PR_NOTIFY_EMAIL", "maheshiv199@gmail.com")
}

pub fn app_environment() -> String {
    var_opt("RWAYVE_ENV")
        .or_else(|| var_opt("ENV"))
        .unwrap_or_else(|| "development".to_string())
}

/// Browser-facing origin of the app; the CORS allowlist and OAuth/email links.
pub fn frontend_url() -> String {
    var_or("FRONTEND_URL", "http://localhost:5173")
}

/// Public origin of this backend when it differs from `FRONTEND_URL`. Used to
/// build the OAuth redirect URI.
pub fn backend_url() -> Option<String> {
    var_opt("BACKEND_URL")
}

/// API base the browser should call; empty means same-origin. Served via `/api/config`.
pub fn public_api_url() -> String {
    var_opt("PUBLIC_API_URL").unwrap_or_default()
}

/// WebSocket base the browser should use; empty means derive from the page origin.
pub fn public_ws_url() -> String {
    var_opt("PUBLIC_WS_URL").unwrap_or_default()
}

/// HS256 signing secret. Panics if missing, blank, or the placeholder `secret`:
/// the app must not run with an insecure JWT secret.
pub fn jwt_secret() -> String {
    let secret = env::var("JWT_SECRET").unwrap_or_else(|_| {
        panic!("JWT_SECRET missing; refusing to start with an insecure default")
    });
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        panic!("JWT_SECRET is empty; refusing to start with an insecure secret");
    }
    if secret == "secret" {
        panic!("JWT_SECRET must not be the placeholder value 'secret'");
    }
    secret
}

/// AES-256-GCM input key material (Hex64). `None` makes at-rest encryption
/// unusable. `aes_hkdf_salt()` lives in wayve-security::config and is read only
/// from inside that crate.
pub fn aes_key() -> Option<String> {
    var_opt("AES_KEY")
}

pub fn redis_url() -> String {
    var_or("REDIS_URL", "redis://redis:6379")
}

/// Path to an offline MaxMind GeoLite2-City `.mmdb`. When unset the User Logs
/// "Location" column is simply blank.
pub fn geoip_db_path() -> Option<String> {
    var_opt("GEOIP_DB_PATH")
}

pub fn local_json_cache_ttl_secs() -> u64 {
    var_opt("LOCAL_JSON_CACHE_TTL_SECS")
        .and_then(|value| value.parse().ok())
        .unwrap_or(60)
}

pub fn local_json_cache_max_capacity() -> u64 {
    var_opt("LOCAL_JSON_CACHE_MAX_CAPACITY")
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000)
}

/// A non-positive or unparseable value falls back to the default so
/// `startup::spawn_log_retention_pruner` can't be tricked into deleting everything.
fn retention_days(key: &str, default: i32) -> i32 {
    var_opt(key)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn activity_retention_days() -> i32 {
    retention_days("ACTIVITY_RETENTION_DAYS", 7)
}

/// Retention window in days for the `audit_logs` security trail. Longer retention
/// should be served by the SIEM forward in `routes/audit.rs`, not by raising this.
pub fn audit_retention_days() -> i32 {
    retention_days("AUDIT_RETENTION_DAYS", 7)
}

pub fn tracing_log_max_bytes() -> u64 {
    var_opt("TRACING_LOG_MAX_BYTES")
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30 * 1024 * 1024)
}

pub fn tracing_log_max_archives() -> usize {
    var_opt("TRACING_LOG_MAX_ARCHIVES")
        .and_then(|value| value.parse().ok())
        .unwrap_or(5)
}

pub struct SiemConfig {
    pub webhook_url: Option<String>,
    pub webhook_token: Option<String>,
}

pub fn siem() -> SiemConfig {
    SiemConfig {
        webhook_url: var_opt("SIEM_WEBHOOK_URL"),
        webhook_token: var_opt("SIEM_WEBHOOK_TOKEN"),
    }
}

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub from: String,
}

/// SMTP settings; `Err` carries the name of the first missing required var.
pub fn smtp() -> Result<SmtpConfig, &'static str> {
    let host = var_opt("SMTP_HOST").ok_or("SMTP_HOST")?;
    let user = var_opt("SMTP_USER").ok_or("SMTP_USER")?;
    let pass = var_opt("SMTP_PASS").ok_or("SMTP_PASS")?;
    let port = var_opt("SMTP_PORT")
        .and_then(|value| value.parse().ok())
        .unwrap_or(587);
    let from = var_opt("SMTP_FROM").unwrap_or_else(|| user.clone());
    Ok(SmtpConfig {
        host,
        port,
        user,
        pass,
        from,
    })
}

/// Full Pub/Sub topic resource name for Gmail push. Unset disables `users.watch`;
/// the 30s poll still covers accounts.
pub fn gmail_push_topic() -> Option<String> {
    var_opt("GMAIL_PUSH_TOPIC")
}

/// Shared secret matched against the `?token=` on the Gmail Pub/Sub push
/// endpoint. Unset accepts any caller, so it is dev-only.
pub fn gmail_push_secret() -> Option<String> {
    var_opt("GMAIL_PUSH_SECRET")
}

pub struct StripeConfig {
    pub secret_key: Option<String>,
    pub webhook_secret: Option<String>,
    pub publishable_key: Option<String>,
    pub api_base: String,
}

pub fn stripe() -> StripeConfig {
    StripeConfig {
        secret_key: var_opt("STRIPE_SECRET_KEY"),
        webhook_secret: var_opt("STRIPE_WEBHOOK_SECRET"),
        publishable_key: var_opt("STRIPE_PUBLISHABLE_KEY"),
        api_base: var_or("STRIPE_API_BASE", "https://api.stripe.com"),
    }
}

pub fn gemini_api_key() -> Option<String> {
    var_opt("GEMINI_API_KEY")
}

/// `(owner, repo)` the AI-fix pipeline dispatches its workflow against, parsed
/// from `GITHUB_REPO` (e.g. `mahesivaya/wayve`). None when unset or malformed.
pub fn github_repo() -> Option<(String, String)> {
    let raw = var_opt("GITHUB_REPO")?;
    let (owner, repo) = raw.trim().split_once('/')?;
    (!owner.is_empty() && !repo.is_empty()).then(|| (owner.to_string(), repo.to_string()))
}

pub fn gemini_model() -> String {
    var_or("GEMINI_MODEL", "gemini-2.0-flash")
}

/// The platform's default Anthropic (Claude) key. When set, it becomes the
/// default AI provider for callers without their own org/platform config — so a
/// prod deployment auto-uses Claude with no in-app configuration. Takes
/// precedence over the Gemini env default (see `ai::provider::resolve_ai_for_user`).
pub fn anthropic_api_key() -> Option<String> {
    var_opt("ANTHROPIC_API_KEY")
}

pub fn anthropic_model() -> String {
    var_or("ANTHROPIC_MODEL", "claude-opus-4-8")
}

/// Shared secret for the inbound Jira webhook, passed as the `?token=` query
/// value. Jira Cloud does not sign webhook payloads, so this token is the only
/// authenticator; when unset the receiver refuses all deliveries.
pub fn jira_webhook_secret() -> Option<String> {
    var_opt("JIRA_WEBHOOK_SECRET")
}

/// Slack app signing secret, used to verify the HMAC-SHA256 `X-Slack-Signature`
/// on inbound Events API requests. When unset the receiver refuses all deliveries.
pub fn slack_signing_secret() -> Option<String> {
    var_opt("SLACK_SIGNING_SECRET")
}

pub struct ZoomConfig {
    pub account_id: String,
    pub client_id: String,
    pub client_secret: String,
}

/// Zoom server-to-server OAuth credentials; `Err` names the first missing var.
pub fn zoom() -> Result<ZoomConfig, &'static str> {
    Ok(ZoomConfig {
        account_id: var_opt("ZOOM_ACCOUNT_ID").ok_or("ZOOM_ACCOUNT_ID")?,
        client_id: var_opt("ZOOM_CLIENT_ID").ok_or("ZOOM_CLIENT_ID")?,
        client_secret: var_opt("ZOOM_CLIENT_SECRET").ok_or("ZOOM_CLIENT_SECRET")?,
    })
}

pub struct GoogleOAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_secret_path: String,
}

pub fn google_oauth() -> GoogleOAuthConfig {
    GoogleOAuthConfig {
        client_id: var_opt("GOOGLE_CLIENT_ID"),
        client_secret: var_opt("GOOGLE_CLIENT_SECRET"),
        redirect_uri: var_opt("GOOGLE_OAUTH_REDIRECT_URI"),
        client_secret_path: var_or("GOOGLE_CLIENT_SECRET_PATH", "client_secret.json"),
    }
}

/// Per-user GitHub OAuth: personal accounts connect their own GitHub to import
/// their repos. Distinct from the shared `GITHUB_TOKEN` PAT the proxy falls back
/// to for public browsing.
pub struct GithubOAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub redirect_uri: Option<String>,
}

pub fn github_oauth() -> GithubOAuthConfig {
    GithubOAuthConfig {
        client_id: var_opt("GITHUB_CLIENT_ID"),
        client_secret: var_opt("GITHUB_CLIENT_SECRET"),
        redirect_uri: var_opt("GITHUB_OAUTH_REDIRECT_URI"),
    }
}

pub struct OutlookOAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub redirect_uri: Option<String>,
}

pub fn outlook_oauth() -> OutlookOAuthConfig {
    OutlookOAuthConfig {
        client_id: var_opt("OUTLOOK_CLIENT_ID"),
        client_secret: var_opt("OUTLOOK_CLIENT_SECRET"),
        redirect_uri: var_opt("OUTLOOK_REDIRECT_URI"),
    }
}

/// Fail-fast check of required configuration; logs which optional integrations
/// are enabled. Call once at startup, after `load_env_files`.
pub fn validate() {
    let _ = jwt_secret();
    if aes_key().is_none() {
        panic!("AES_KEY is not set; configure a 64-character Hex64 key");
    }
    if var_opt("FRONTEND_URL").is_none() {
        if app_environment() == "production" {
            panic!("FRONTEND_URL must be set in production");
        }
        warn!(target: "config", default = %frontend_url(), "FRONTEND_URL not set; using default");
    }

    // Log the optional integration surface so misconfig is visible at boot.
    let feature = |name: &str, enabled: bool| {
        if enabled {
            info!(target: "config", "{name}: enabled");
        } else {
            info!(target: "config", "{name}: disabled (env not set)");
        }
    };
    feature("stripe (billing)", stripe().secret_key.is_some());
    feature("anthropic (AI)", anthropic_api_key().is_some());
    feature("gemini (AI)", gemini_api_key().is_some());
    feature("zoom (scheduler)", zoom().is_ok());
    feature("google oauth", google_oauth().client_id.is_some());
    feature("github oauth", github_oauth().client_id.is_some());
    feature("outlook oauth", outlook_oauth().client_id.is_some());
    feature("smtp (email send)", smtp().is_ok());
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn runtime_role_defaults_to_api() {
        unsafe { env::remove_var("RWAYVE_ROLE") };
        assert_eq!(RuntimeRole::from_env(), RuntimeRole::Api);
    }

    #[test]
    #[serial_test::serial]
    fn runtime_role_parses_known_values() {
        unsafe { env::set_var("RWAYVE_ROLE", "email-sync-worker") };
        assert_eq!(RuntimeRole::from_env(), RuntimeRole::EmailSyncWorker);
        unsafe { env::set_var("RWAYVE_ROLE", "email-body-worker") };
        assert_eq!(RuntimeRole::from_env(), RuntimeRole::EmailBodyWorker);
        unsafe { env::set_var("RWAYVE_ROLE", "all") };
        assert_eq!(RuntimeRole::from_env(), RuntimeRole::All);
        unsafe { env::remove_var("RWAYVE_ROLE") };
    }

    #[test]
    #[serial_test::serial]
    fn db_max_connections_uses_role_defaults() {
        unsafe { env::remove_var("DATABASE_MAX_CONNECTIONS") };
        assert_eq!(db_max_connections(RuntimeRole::Api), 50);
        assert_eq!(db_max_connections(RuntimeRole::EmailSyncWorker), 5);
    }

    #[test]
    #[serial_test::serial]
    fn listen_port_defaults_when_unset() {
        unsafe { env::remove_var("PORT") };
        assert_eq!(listen_port(), 8080);
    }

    #[test]
    #[serial_test::serial]
    fn listen_port_parses_and_falls_back() {
        unsafe { env::set_var("PORT", "9090") };
        assert_eq!(listen_port(), 9090);
        unsafe { env::set_var("PORT", "garbage") };
        assert_eq!(listen_port(), 8080);
    }

    #[test]
    #[serial_test::serial]
    fn database_url_prefers_explicit_value() {
        let saved = env::var("DATABASE_URL").ok();
        unsafe { env::set_var("DATABASE_URL", "postgres://x:y@h:1/db") };
        assert_eq!(database_url(), "postgres://x:y@h:1/db");
        unsafe {
            match &saved {
                Some(value) => env::set_var("DATABASE_URL", value),
                None => env::remove_var("DATABASE_URL"),
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn database_url_derives_from_postgres_parts() {
        let saved = env::var("DATABASE_URL").ok();
        unsafe {
            env::remove_var("DATABASE_URL");
            env::set_var("POSTGRES_USER", "u");
            env::set_var("POSTGRES_PASSWORD", "p");
            env::set_var("POSTGRES_HOST", "dbhost");
            env::set_var("POSTGRES_PORT", "6543");
            env::set_var("POSTGRES_DB", "mydb");
        }
        assert_eq!(database_url(), "postgres://u:p@dbhost:6543/mydb");
        unsafe {
            for key in [
                "POSTGRES_USER",
                "POSTGRES_PASSWORD",
                "POSTGRES_HOST",
                "POSTGRES_PORT",
                "POSTGRES_DB",
            ] {
                env::remove_var(key);
            }
            match &saved {
                Some(value) => env::set_var("DATABASE_URL", value),
                None => env::remove_var("DATABASE_URL"),
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn jwt_secret_panics_when_missing() {
        unsafe { env::remove_var("JWT_SECRET") };
        assert!(std::panic::catch_unwind(jwt_secret).is_err());
        unsafe { env::set_var("JWT_SECRET", "test-jwt-secret") };
    }

    #[test]
    #[serial_test::serial]
    fn jwt_secret_rejects_placeholder() {
        unsafe { env::set_var("JWT_SECRET", "secret") };
        let result = std::panic::catch_unwind(jwt_secret);
        unsafe { env::set_var("JWT_SECRET", "test-jwt-secret") };
        assert!(result.is_err());
    }

    #[test]
    #[serial_test::serial]
    fn jwt_secret_accepts_configured_value() {
        unsafe { env::set_var("JWT_SECRET", "test-jwt-secret") };
        assert_eq!(jwt_secret(), "test-jwt-secret");
    }

    #[test]
    #[serial_test::serial]
    fn frontend_url_defaults_to_localhost() {
        let saved = env::var("FRONTEND_URL").ok();
        unsafe { env::remove_var("FRONTEND_URL") };
        assert_eq!(frontend_url(), "http://localhost:5173");
        unsafe {
            if let Some(value) = saved {
                env::set_var("FRONTEND_URL", value);
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn smtp_reports_first_missing_var() {
        let saved: Vec<_> = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]
            .iter()
            .map(|key| (*key, env::var(key).ok()))
            .collect();
        unsafe {
            for (key, _) in &saved {
                env::remove_var(key);
            }
        }
        assert_eq!(smtp().err(), Some("SMTP_HOST"));
        unsafe {
            for (key, value) in saved {
                if let Some(value) = value {
                    env::set_var(key, value);
                }
            }
        }
    }
}
