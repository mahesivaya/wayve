//! Inbound Jira Cloud webhook: keeps linked Wayve tasks in sync when an issue
//! changes in Jira, complementing the on-demand pull in `sync::pull`.
//!
//! Jira Cloud does not sign webhook deliveries, so the only authenticator is a
//! shared secret passed as the `?token=` query value and checked against
//! `config::jira_webhook_secret()`. The route is public, with no JWT.
//!
//! The connection is per-user but a webhook is per-site, so an incoming issue is
//! applied to every task that links it, matched on `(jira_issue_key, jira_base)`.
//! Issues nobody imported match nothing, which is correct.

use crate::prelude::*;
use tracing::{info, instrument, warn};

use super::mapping::map_issue_fields;
use super::models::{JiraWebhookIssue, JiraWebhookPayload};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(jira_webhook);
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

#[post("/webhooks/fluxze_webhook")]
#[instrument(target = "worker", skip(req, pool, body))]
pub async fn jira_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Bytes,
) -> AppResult {
    // The URL secret is the only authenticator, so with none configured we cannot
    // authenticate anyone and must refuse.
    let Some(secret) = crate::config::jira_webhook_secret() else {
        warn!(target: "worker", "JIRA_WEBHOOK_SECRET not set; rejecting Jira webhook");
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Jira webhook not configured" })));
    };
    let provided = web::Query::<TokenQuery>::from_query(req.query_string())
        .ok()
        .and_then(|q| q.into_inner().token)
        .unwrap_or_default();
    if !constant_time_eq(provided.as_bytes(), secret.as_bytes()) {
        return Err(AppError::Unauthorized);
    }

    let payload: JiraWebhookPayload = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => {
            warn!(target: "worker", error = %e, "jira webhook: unparseable payload");
            return Err(AppError::bad_request("invalid webhook payload"));
        }
    };

    let Some(issue) = payload.issue else {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true, "ignored": true })));
    };

    match payload.webhook_event.as_str() {
        "jira:issue_created" | "jira:issue_updated" => {
            let base = issue.self_url.as_deref().and_then(site_base_from_self);
            if base.is_none() {
                warn!(target: "worker", key = %issue.key, "jira webhook: no site base in issue.self; matching by key only");
            }
            let updated = apply_to_tasks(pool.get_ref(), &issue, base.as_deref()).await?;
            info!(target: "worker", key = %issue.key, updated, "jira webhook applied");
            Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true, "updated": updated })))
        }
        // Deleting the Jira issue deliberately does not delete the Wayve task: the
        // local task may still be wanted.
        "jira:issue_deleted" => {
            info!(target: "worker", key = %issue.key, "jira webhook: issue deleted (no-op)");
            Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true, "ignored": true })))
        }
        other => {
            info!(target: "worker", event = other, "jira webhook: unhandled event");
            Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true, "ignored": true })))
        }
    }
}

/// Update every task linked to this issue. Matching on the `jira_base` site as
/// well as the key, when the site is known, stops the same key on a different site
/// from cross-updating.
async fn apply_to_tasks(
    pool: &PgPool,
    issue: &JiraWebhookIssue,
    base: Option<&str>,
) -> Result<u64, AppError> {
    let mapped = map_issue_fields(&issue.key, &issue.fields);
    let result = sqlx::query(
        "UPDATE tasks SET
            name = $1,
            description = $2,
            priority = $3,
            status = $4,
            updated_at = NOW()
         WHERE jira_issue_key = $5
           AND ($6::text IS NULL OR jira_base = $6)",
    )
    .bind(&mapped.name)
    .bind(&mapped.description)
    .bind(mapped.priority)
    .bind(mapped.status)
    .bind(&issue.key)
    .bind(base)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Reduce a Jira `self` URL to its site base, the form stored in `jira_base`.
/// `None` when there is no scheme or host.
fn site_base_from_self(self_url: &str) -> Option<String> {
    let scheme_end = self_url.find("://")? + 3;
    let rest = &self_url[scheme_end..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    let host = &rest[..host_end];
    if host.is_empty() {
        return None;
    }
    Some(format!("{}{host}", &self_url[..scheme_end]))
}

/// Length-aware constant-time byte comparison, so a wrong token can't be
/// recovered by timing the early-exit of `==`.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_base_strips_path() {
        assert_eq!(
            site_base_from_self("https://acme.atlassian.net/rest/api/2/issue/10001").as_deref(),
            Some("https://acme.atlassian.net")
        );
        assert_eq!(
            site_base_from_self("https://acme.atlassian.net").as_deref(),
            Some("https://acme.atlassian.net")
        );
        assert_eq!(site_base_from_self("not-a-url"), None);
    }

    #[test]
    fn constant_time_eq_matches() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"sekret"));
        assert!(!constant_time_eq(b"secret", b"secret-longer"));
        assert!(!constant_time_eq(b"", b"x"));
    }
}
