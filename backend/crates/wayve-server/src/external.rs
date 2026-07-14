// Base URLs for external services. Each defaults to the production endpoint and
// is overridable by env var, which lets tests swap in a wiremock server for any
// single provider without scattering #[cfg(test)] branches through handlers.

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

/// Root for Anthropic Messages API calls; `/v1/messages` is appended. An org's
/// `openai_compatible` provider carries its own base URL instead.
pub fn anthropic_base() -> String {
    std::env::var("ANTHROPIC_API_BASE").unwrap_or_else(|_| "https://api.anthropic.com".to_string())
}

/// Root for Gmail REST calls. The sync and body workers build per-message URLs
/// off this base.
pub fn gmail_api_base() -> String {
    std::env::var("GMAIL_API_BASE").unwrap_or_else(|_| "https://gmail.googleapis.com".to_string())
}

pub fn github_api_base() -> String {
    std::env::var("GITHUB_API_BASE").unwrap_or_else(|_| "https://api.github.com".to_string())
}

/// The browser redirect target for the GitHub OAuth consent screen.
pub fn github_oauth_authorize_url() -> String {
    std::env::var("GITHUB_OAUTH_AUTHORIZE_URL")
        .unwrap_or_else(|_| "https://github.com/login/oauth/authorize".to_string())
}

/// Server-to-server token exchange; never called from the browser.
pub fn github_oauth_token_url() -> String {
    std::env::var("GITHUB_OAUTH_TOKEN_URL")
        .unwrap_or_else(|_| "https://github.com/login/oauth/access_token".to_string())
}

/// Root for Jira Cloud REST calls. Each connection carries its own site base, so
/// `JIRA_API_BASE` overrides it wholesale rather than per connection.
pub fn jira_api_base(connection_base: &str) -> String {
    std::env::var("JIRA_API_BASE")
        .unwrap_or_else(|_| connection_base.trim_end_matches('/').to_string())
}

pub fn slack_api_base() -> String {
    std::env::var("SLACK_API_BASE").unwrap_or_else(|_| "https://slack.com/api".to_string())
}

/// Root for GitLab REST calls. Each connection carries its own instance base
/// (gitlab.com or self-hosted), so `GITLAB_API_BASE` overrides it wholesale.
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

/// Microsoft identity platform authority. `MICROSOFT_AUTHORITY` wins if set;
/// otherwise this falls back to a tenant-pinned URL, or `common`.
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

/// Microsoft Graph API root, used for mailbox sync, send, and profile reads.
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

/// Test-only escape hatch for the MCP client's SSRF guard, which otherwise
/// rejects non-https URLs and any host resolving to a private, link-local, or
/// loopback address (see `integrations::mcp::client`). Never set this in a
/// deployed environment.
pub fn mcp_allow_private_hosts() -> bool {
    matches!(
        std::env::var("MCP_ALLOW_PRIVATE_HOSTS").as_deref(),
        Ok("1") | Ok("true")
    )
}
