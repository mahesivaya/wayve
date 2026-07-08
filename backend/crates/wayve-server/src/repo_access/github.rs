//! GitHub collaborator reads/writes for the per-repo Access panel. Reuses the
//! shared `HTTP_CLIENT` + `github_api_base` + the caller's effective token
//! (`github_proxy::effective_github_token`).
//!
//! Reading collaborators needs only repo read; **adding/removing** a collaborator
//! needs an **admin**-scoped token on the repo. When the token lacks that, GitHub
//! returns 403/404 — we surface that as [`SyncOutcome::Forbidden`] so the caller
//! can still record the Wayve-side grant and tell the admin GitHub wasn't changed
//! (never a hard 500).

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use std::time::Duration;
use tracing::warn;

const GH_TIMEOUT: Duration = Duration::from_secs(20);

/// A repo access level in Wayve terms. `Admin` is read-only info surfaced from
/// GitHub — we never grant admin from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Read,
    Write,
    Admin,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Read => "read",
            Level::Write => "write",
            Level::Admin => "admin",
        }
    }

    /// The GitHub collaborator `permission` value used when granting. `Admin` is
    /// not grantable from this feature (falls back to `push`).
    pub fn github_permission(self) -> &'static str {
        match self {
            Level::Read => "pull",
            Level::Write | Level::Admin => "push",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        match s.trim().to_ascii_lowercase().as_str() {
            "read" => Some(Level::Read),
            "write" => Some(Level::Write),
            "admin" => Some(Level::Admin),
            _ => None,
        }
    }
}

/// One GitHub collaborator on a repo, with the level derived from its permission
/// booleans.
pub struct Collaborator {
    pub login: String,
    pub level: Level,
}

/// Result of a best-effort collaborator mutation on GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    /// GitHub accepted the change (added/updated/removed, or already in that state).
    Synced,
    /// Token lacks admin on the repo (403/404) — GitHub was not changed.
    Forbidden,
    /// Transport or unexpected upstream error.
    Failed,
}

/// GitHub's `permissions` object → our coarse level. admin > push/maintain (write)
/// > pull/triage (read).
fn level_from_node(node: &Value) -> Level {
    let perms = node.get("permissions");
    let flag = |k: &str| {
        perms
            .and_then(|p| p.get(k))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    if flag("admin") {
        Level::Admin
    } else if flag("push") || flag("maintain") {
        Level::Write
    } else {
        Level::Read
    }
}

fn authed(builder: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    let mut b = builder
        .timeout(GH_TIMEOUT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");
    if let Some(t) = token {
        b = b.header("Authorization", format!("Bearer {t}"));
    }
    b
}

/// Direct collaborators on `owner/repo` with their access level. Returns `Err`
/// only on transport/parse failure; the caller may then show the Wayve-side
/// grants alone.
pub async fn list_collaborators(
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<Vec<Collaborator>, AppError> {
    let base = crate::external::github_api_base();
    let url = format!("{base}/repos/{owner}/{repo}/collaborators");
    let resp = authed(HTTP_CLIENT.get(&url), token)
        .query(&[("affiliation", "direct"), ("per_page", "100")])
        .send()
        .await
        .map_err(|e| {
            warn!(target: "worker", error = ?e, "list collaborators transport error");
            AppError::bad_request("Could not reach GitHub")
        })?;
    if !resp.status().is_success() {
        return Err(AppError::bad_request(format!(
            "GitHub returned HTTP {}",
            resp.status().as_u16()
        )));
    }
    let body: Value = resp.json().await.map_err(|e| {
        warn!(target: "worker", error = ?e, "list collaborators parse error");
        AppError::bad_request("Invalid response from GitHub")
    })?;
    let mut out = Vec::new();
    if let Some(arr) = body.as_array() {
        for node in arr {
            if let Some(login) = node.get("login").and_then(|l| l.as_str()) {
                out.push(Collaborator {
                    login: login.to_string(),
                    level: level_from_node(node),
                });
            }
        }
    }
    Ok(out)
}

/// Add/update `login` as a collaborator at `level`. 201/204 → synced; 403/404 →
/// forbidden (no admin); anything else → failed. Never returns `Err`.
pub async fn add_collaborator(
    owner: &str,
    repo: &str,
    login: &str,
    level: Level,
    token: Option<&str>,
) -> SyncOutcome {
    let base = crate::external::github_api_base();
    let url = format!("{base}/repos/{owner}/{repo}/collaborators/{login}");
    let body = serde_json::json!({ "permission": level.github_permission() });
    match authed(HTTP_CLIENT.put(&url), token)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => classify(resp.status().as_u16()),
        Err(e) => {
            warn!(target: "worker", error = ?e, "add collaborator transport error");
            SyncOutcome::Failed
        }
    }
}

/// Remove `login` as a collaborator. 204/404 → synced (gone either way); 403 →
/// forbidden; else failed.
pub async fn remove_collaborator(
    owner: &str,
    repo: &str,
    login: &str,
    token: Option<&str>,
) -> SyncOutcome {
    let base = crate::external::github_api_base();
    let url = format!("{base}/repos/{owner}/{repo}/collaborators/{login}");
    match authed(HTTP_CLIENT.delete(&url), token).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            // 404 on delete means "not a collaborator" → already in desired state.
            if code == 404 {
                SyncOutcome::Synced
            } else {
                classify(code)
            }
        }
        Err(e) => {
            warn!(target: "worker", error = ?e, "remove collaborator transport error");
            SyncOutcome::Failed
        }
    }
}

fn classify(code: u16) -> SyncOutcome {
    match code {
        200 | 201 | 204 => SyncOutcome::Synced,
        401 | 403 | 404 => SyncOutcome::Forbidden,
        _ => SyncOutcome::Failed,
    }
}
