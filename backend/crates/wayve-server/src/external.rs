// Centralized base URLs for external services. Each defaults to the real
// production endpoint but can be overridden in tests (or for self-hosted
// gateways) by setting the matching env var. Keeping all overrides in one
// place makes it cheap to swap a wiremock server in for any single provider
// without scattering #[cfg(test)] branches through handlers.

pub fn google_token_url() -> String {
    std::env::var("GOOGLE_TOKEN_URL")
        .unwrap_or_else(|_| "https://oauth2.googleapis.com/token".to_string())
}

pub fn google_userinfo_url() -> String {
    std::env::var("GOOGLE_USERINFO_URL")
        .unwrap_or_else(|_| "https://www.googleapis.com/oauth2/v2/userinfo".to_string())
}

pub fn gmail_send_url() -> String {
    std::env::var("GMAIL_SEND_URL").unwrap_or_else(|_| {
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send".to_string()
    })
}

pub fn gemini_base() -> String {
    std::env::var("GEMINI_API_BASE")
        .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".to_string())
}

/// Root for Anthropic Messages API calls (`/v1/messages` is appended). Defaults
/// to the public endpoint; `ANTHROPIC_API_BASE` points it at a wiremock server in
/// tests. An org's `openai_compatible` provider carries its own base URL instead.
pub fn anthropic_base() -> String {
    std::env::var("ANTHROPIC_API_BASE").unwrap_or_else(|_| "https://api.anthropic.com".to_string())
}

/// Root for Gmail REST calls. The two workers (sync + body_worker) build
/// per-message URLs off this base; tests point it at a wiremock server.
pub fn gmail_api_base() -> String {
    std::env::var("GMAIL_API_BASE").unwrap_or_else(|_| "https://gmail.googleapis.com".to_string())
}

/// Root for GitHub REST calls. `parse_and_validate_repo` builds the
/// `/repos/{owner}/{repo}` lookup off this base; tests point it at a wiremock
/// server so repo validation runs offline.
pub fn github_api_base() -> String {
    std::env::var("GITHUB_API_BASE").unwrap_or_else(|_| "https://api.github.com".to_string())
}

/// GitHub OAuth authorize endpoint (the browser redirect target). Overridable
/// for tests via `GITHUB_OAUTH_AUTHORIZE_URL`.
pub fn github_oauth_authorize_url() -> String {
    std::env::var("GITHUB_OAUTH_AUTHORIZE_URL")
        .unwrap_or_else(|_| "https://github.com/login/oauth/authorize".to_string())
}

/// GitHub OAuth token-exchange endpoint (server-to-server). Overridable for
/// tests via `GITHUB_OAUTH_TOKEN_URL` (point at a wiremock server).
pub fn github_oauth_token_url() -> String {
    std::env::var("GITHUB_OAUTH_TOKEN_URL")
        .unwrap_or_else(|_| "https://github.com/login/oauth/access_token".to_string())
}

/// Root for Jira Cloud REST calls. Each connection carries its own site base
/// (e.g. `https://acme.atlassian.net`), which is passed in; the `JIRA_API_BASE`
/// env var overrides it wholesale so tests can point every Jira call at a
/// wiremock server without per-connection plumbing.
pub fn jira_api_base(connection_base: &str) -> String {
    std::env::var("JIRA_API_BASE")
        .unwrap_or_else(|_| connection_base.trim_end_matches('/').to_string())
}

/// Root for Slack Web API calls (`https://slack.com/api`). `SLACK_API_BASE`
/// overrides it wholesale so tests can point every Slack call at a wiremock
/// server without per-connection plumbing.
pub fn slack_api_base() -> String {
    std::env::var("SLACK_API_BASE").unwrap_or_else(|_| "https://slack.com/api".to_string())
}

/// Root for GitLab REST calls. Each connection carries its own instance base
/// (e.g. `https://gitlab.com` or a self-hosted host); `GITLAB_API_BASE`
/// overrides it wholesale so tests can point every GitLab call at a wiremock
/// server.
pub fn gitlab_api_base(connection_base: &str) -> String {
    std::env::var("GITLAB_API_BASE")
        .unwrap_or_else(|_| connection_base.trim_end_matches('/').to_string())
}

pub fn zoom_oauth_token_url() -> String {
    std::env::var("ZOOM_OAUTH_TOKEN_URL")
        .unwrap_or_else(|_| "https://zoom.us/oauth/token".to_string())
}

pub fn zoom_api_base() -> String {
    std::env::var("ZOOM_API_BASE").unwrap_or_else(|_| "https://api.zoom.us".to_string())
}

/// Microsoft identity platform authority. `MICROSOFT_AUTHORITY` wins if set
/// (e.g. `.../consumers` for personal mailboxes, `.../common` for any account);
/// otherwise it falls back to a tenant-pinned URL or `common`.
pub fn microsoft_authority() -> String {
    if let Ok(val) = std::env::var("MICROSOFT_AUTHORITY") {
        let val = val.trim();
        if !val.is_empty() {
            return val.to_string();
        }
    }
    let tenant = std::env::var("OUTLOOK_TENANT_ID")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "common".to_string());
    format!("https://login.microsoftonline.com/{tenant}")
}

/// Microsoft Graph API root — used for mailbox sync, send, and profile reads.
pub fn microsoft_graph_base() -> String {
    std::env::var("MICROSOFT_GRAPH_BASE")
        .unwrap_or_else(|_| "https://graph.microsoft.com".to_string())
}

/// Google Calendar events endpoint for the primary calendar.
pub fn google_calendar_url() -> String {
    std::env::var("GOOGLE_CALENDAR_URL").unwrap_or_else(|_| {
        "https://www.googleapis.com/calendar/v3/calendars/primary/events".to_string()
    })
}

/// TEST-ONLY escape hatch for the MCP client's SSRF guard. A connected MCP
/// server URL is admin-supplied and fetched server-side, so production rejects
/// non-https URLs and any host that resolves to a private/link-local/loopback
/// address (see `integrations::mcp::client`). Tests run a `wiremock` server on
/// `127.0.0.1`, which that guard would (correctly) block — setting
/// `MCP_ALLOW_PRIVATE_HOSTS=1` relaxes it so the handshake can be exercised
/// offline. NEVER set this in any deployed environment.
pub fn mcp_allow_private_hosts() -> bool {
    matches!(
        std::env::var("MCP_ALLOW_PRIVATE_HOSTS").as_deref(),
        Ok("1") | Ok("true")
    )
}
