//! Server-side GitHub reads for the assignee-suggestion feature: a repo's file
//! list (to ground the story→files mapping) and per-file commit authors (to
//! attribute expertise). Every call goes through the shared `HTTP_CLIENT` with
//! the caller's effective token (`github_proxy::effective_github_token`).
//!
//! Both the tree and per-path commit lookups are cached in-process (TTL) keyed
//! by repo/path, because a suggestion fans out one `commits?path=` call per
//! candidate file and GitHub rate-limits aggressively.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use chrono::{DateTime, Utc};
use std::time::Duration;
use tracing::warn;

use crate::cache::TtlCache;

const GH_TIMEOUT: Duration = Duration::from_secs(20);
/// Cap on how many file paths we keep from a repo tree, so a huge monorepo
/// can't blow up the AI prompt or the fan-out. Paths beyond this are dropped.
pub const MAX_TREE_PATHS: usize = 1500;
/// Commits fetched per file when attributing authorship (newest first).
const COMMITS_PER_FILE: u32 = 30;
const CACHE_TTL_SECS: u64 = 300;

/// Cached repo file lists, keyed by `owner/repo`.
static TREE_CACHE: Lazy<TtlCache<String, Vec<String>>> =
    Lazy::new(|| TtlCache::new(256, CACHE_TTL_SECS));
/// Cached per-file commit history, keyed by `owner/repo\npath`.
static COMMITS_CACHE: Lazy<TtlCache<String, Vec<FileCommit>>> =
    Lazy::new(|| TtlCache::new(4096, CACHE_TTL_SECS));

/// One past change to a file: who made it and when.
#[derive(Clone, Debug)]
pub struct FileCommit {
    /// GitHub login of the author (null on some commits — e.g. unlinked email).
    pub login: Option<String>,
    /// Commit author display name — the fallback label when `login` is absent.
    pub name: Option<String>,
    pub date: Option<DateTime<Utc>>,
}

async fn github_get(
    url: &str,
    query: &[(&str, &str)],
    token: Option<&str>,
) -> Result<Value, AppError> {
    let mut builder = HTTP_CLIENT
        .get(url)
        .timeout(GH_TIMEOUT)
        .query(query)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "rwayve-app");
    if let Some(t) = token {
        builder = builder.header("Authorization", format!("Bearer {t}"));
    }
    let resp = builder.send().await.map_err(|e| {
        warn!(target: "worker", error = ?e, "github suggest request failed");
        AppError::bad_request("Could not reach GitHub")
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(AppError::bad_request(format!(
            "GitHub returned HTTP {}",
            status.as_u16()
        )));
    }
    resp.json::<Value>().await.map_err(|e| {
        warn!(target: "worker", error = ?e, "github suggest response parse failed");
        AppError::bad_request("Invalid response from GitHub")
    })
}

/// The repo's default branch (e.g. "main"); defaults to "main" if absent.
async fn default_branch(
    base: &str,
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<String, AppError> {
    let url = format!("{base}/repos/{owner}/{repo}");
    let v = github_get(&url, &[], token).await?;
    Ok(v.get("default_branch")
        .and_then(|b| b.as_str())
        .unwrap_or("main")
        .to_string())
}

/// Every file path (git blob) in the repo's default branch, capped at
/// [`MAX_TREE_PATHS`]. Cached per `owner/repo`.
pub async fn repo_file_paths(
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<Vec<String>, AppError> {
    let key = format!("{owner}/{repo}");
    if let Some(hit) = TREE_CACHE.get(&key).await {
        return Ok(hit);
    }

    let base = crate::external::github_api_base();
    let branch = default_branch(&base, owner, repo, token).await?;
    let url = format!("{base}/repos/{owner}/{repo}/git/trees/{branch}");
    let v = github_get(&url, &[("recursive", "1")], token).await?;

    let mut paths: Vec<String> = Vec::new();
    if let Some(tree) = v.get("tree").and_then(|t| t.as_array()) {
        for node in tree {
            if node.get("type").and_then(|t| t.as_str()) == Some("blob")
                && let Some(p) = node.get("path").and_then(|p| p.as_str())
            {
                paths.push(p.to_string());
                if paths.len() >= MAX_TREE_PATHS {
                    warn!(target: "worker", owner, repo, "repo tree exceeds {MAX_TREE_PATHS} paths; truncating");
                    break;
                }
            }
        }
    }

    TREE_CACHE.insert(key, paths.clone()).await;
    Ok(paths)
}

/// Recent commits that touched `path`, newest first. Cached per repo+path.
pub async fn commits_for_path(
    owner: &str,
    repo: &str,
    path: &str,
    token: Option<&str>,
) -> Result<Vec<FileCommit>, AppError> {
    let key = format!("{owner}/{repo}\n{path}");
    if let Some(hit) = COMMITS_CACHE.get(&key).await {
        return Ok(hit);
    }

    let base = crate::external::github_api_base();
    let url = format!("{base}/repos/{owner}/{repo}/commits");
    let per_page = COMMITS_PER_FILE.to_string();
    let v = github_get(&url, &[("path", path), ("per_page", &per_page)], token).await?;

    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for c in arr {
            let login = c
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|l| l.as_str())
                .map(str::to_string);
            let author = c.get("commit").and_then(|c| c.get("author"));
            let name = author
                .and_then(|a| a.get("name"))
                .and_then(|n| n.as_str())
                .map(str::to_string);
            let date = author
                .and_then(|a| a.get("date"))
                .and_then(|d| d.as_str())
                .and_then(|d| DateTime::parse_from_rfc3339(d).ok())
                .map(|dt| dt.with_timezone(&Utc));
            out.push(FileCommit { login, name, date });
        }
    }

    COMMITS_CACHE.insert(key, out.clone()).await;
    Ok(out)
}
