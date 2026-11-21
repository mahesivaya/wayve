//! Webhook deliveries from the Hadal GitHub App (`POST /api/github-app/webhook`).
//!
//! GitHub posts here when something changes in a repository an organization
//! shared with the App. Pull request activity clears the cached copy of that
//! repo and pushes a `github:pulls` frame, over the same per-user WebSocket as
//! chat and email, to the organization's members who can see the repo, so an
//! open Code & reviews page reloads its pull requests within a second or two.
//! An uninstall on GitHub forgets the installation.
//!
//! Every delivery must carry GitHub's HMAC-SHA256 signature made with
//! `GITHUB_APP_WEBHOOK_SECRET`; without the secret configured, deliveries are
//! refused rather than trusted unsigned. The frame names only the repo, the PR
//! number and what happened; the data itself is still read through the proxy's
//! access checks.

use crate::cache::Cache;
use crate::prelude::*;
use actix_web::http::header::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing::{info, instrument, warn};

type HmacSha256 = Hmac<Sha256>;

/// The pull request events an open Code & reviews page cares about.
const PULL_EVENTS: [&str; 3] = [
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
];

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    (0..input.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(input.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Whether `signature` (`sha256=<hex>`) is GitHub's HMAC of `body` with `secret`.
fn signature_matches(secret: &str, signature: Option<&str>, body: &[u8]) -> bool {
    let Some(expected) = signature
        .and_then(|s| s.strip_prefix("sha256="))
        .and_then(decode_hex)
    else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// What a pull request delivery is about.
#[derive(Debug, PartialEq)]
struct PullActivity {
    installation_id: i64,
    repo: String,
    number: Option<i64>,
    action: String,
}

fn pull_activity(payload: &Value) -> Option<PullActivity> {
    let installation_id = payload.get("installation")?.get("id")?.as_i64()?;
    let repo = payload
        .get("repository")?
        .get("full_name")?
        .as_str()?
        .to_string();
    let (owner, name) = repo.split_once('/')?;
    if !crate::github_proxy::valid_repo_segment(owner)
        || !crate::github_proxy::valid_repo_segment(name)
    {
        return None;
    }
    let number = payload
        .get("pull_request")
        .and_then(|pr| pr.get("number"))
        .and_then(Value::as_i64);
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(PullActivity {
        installation_id,
        repo,
        number,
        action,
    })
}

/// Who hears about activity in `repo`, by the same rules the Code Repo proxy
/// applies:
/// - members of `org_id` (the organization the installation belongs to, if
///   any), when the repo is linked to one of its projects and they are its
///   owner or an admin, or were granted that repo;
/// - platform staff, whose Code & reviews can open any repo: owners and admins,
///   or members granted that repo.
pub(crate) async fn recipients(
    pool: &PgPool,
    org_id: Option<i32>,
    repo: &str,
) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar::<_, i32>(
        "SELECT om.user_id
           FROM organization_members om
          WHERE $1::int IS NOT NULL
            AND om.organization_id = $1
            AND EXISTS (
                  SELECT 1 FROM projects p
                   WHERE p.organization_id = $1
                     AND LOWER(p.github_owner || '/' || p.github_repo) = LOWER($2))
            AND (om.role IN ('owner', 'super_admin', 'admin')
                 OR EXISTS (
                      SELECT 1 FROM member_project_access g
                       WHERE g.user_id = om.user_id
                         AND LOWER(g.repo_full_name) = LOWER($2)))
         UNION
         SELECT pm.user_id
           FROM platform_members pm
          WHERE pm.role IN ('owner', 'super_admin', 'admin')
             OR EXISTS (
                  SELECT 1 FROM member_project_access g
                   WHERE g.user_id = pm.user_id
                     AND LOWER(g.repo_full_name) = LOWER($2))",
    )
    .bind(org_id)
    .bind(repo)
    .fetch_all(pool)
    .await
}

async fn on_pull_activity(pool: &PgPool, cache: &Option<Cache>, event: &str, payload: &Value) {
    let Some(activity) = pull_activity(payload) else {
        return;
    };
    // A fresh read on the next request, whoever makes it.
    crate::github_proxy::invalidate_cached(&format!("repos/{}", activity.repo)).await;

    let org_id = sqlx::query_scalar::<_, i32>(
        "SELECT organization_id FROM github_installations WHERE installation_id = $1",
    )
    .bind(activity.installation_id)
    .fetch_optional(pool)
    .await;
    // No organization when the installation was never connected in Hadal;
    // platform staff still hear about it.
    let org_id = match org_id {
        Ok(org_id) => org_id,
        Err(e) => {
            warn!(target: "github", error = ?e, "github webhook: installation lookup failed");
            return;
        }
    };
    let users = match recipients(pool, org_id, &activity.repo).await {
        Ok(users) => users,
        Err(e) => {
            warn!(target: "github", ?org_id, error = ?e, "github webhook: recipient lookup failed");
            return;
        }
    };
    let frame = serde_json::json!({
        "type": "github:pulls",
        "repo": activity.repo,
        "number": activity.number,
        "action": activity.action,
        "event": event,
    })
    .to_string();
    info!(target: "github", ?org_id, repo = %activity.repo, event, action = %activity.action,
          recipients = users.len(), "github pull activity pushed");
    for user_id in users {
        crate::chat::fan_out_user(cache, user_id, frame.clone()).await;
    }
}

/// The App was uninstalled on GitHub: forget it, so the organization shows as
/// not connected instead of failing to mint tokens.
async fn on_uninstall(pool: &PgPool, payload: &Value) {
    let Some(installation_id) = payload
        .get("installation")
        .and_then(|i| i.get("id"))
        .and_then(Value::as_i64)
    else {
        return;
    };
    let removed = sqlx::query_scalar::<_, i32>(
        "DELETE FROM github_installations WHERE installation_id = $1 RETURNING organization_id",
    )
    .bind(installation_id)
    .fetch_optional(pool)
    .await;
    match removed {
        Ok(Some(org_id)) => {
            crate::github_app::forget_installation(installation_id).await;
            crate::github_proxy::invalidate_org_cache(org_id).await;
            info!(target: "github", org_id, installation_id, "github app uninstalled; connection removed");
        }
        Ok(None) => {}
        Err(e) => {
            warn!(target: "github", installation_id, error = ?e, "github webhook: uninstall cleanup failed")
        }
    }
}

#[post("/github-app/webhook")]
#[instrument(target = "http", skip(req, body, pool, cache))]
pub async fn github_app_webhook(
    req: HttpRequest,
    body: web::Bytes,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
) -> impl Responder {
    let Some(secret) = crate::config::github_app_webhook_secret() else {
        warn!(target: "github", "github app webhook refused: GITHUB_APP_WEBHOOK_SECRET is not set");
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Webhook not configured" }));
    };
    if !signature_matches(&secret, header(req.headers(), "x-hub-signature-256"), &body) {
        warn!(target: "github", "github app webhook refused: bad or missing signature");
        return HttpResponse::Unauthorized().finish();
    }
    let event = header(req.headers(), "x-github-event")
        .unwrap_or("unknown")
        .to_string();
    // Signed but unreadable: nothing to act on, and a non-2xx would only make
    // GitHub retry the same body.
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return HttpResponse::Ok().json(serde_json::json!({ "ok": true }));
    };

    if PULL_EVENTS.contains(&event.as_str()) {
        on_pull_activity(pool.get_ref(), cache.get_ref(), &event, &payload).await;
    } else if event == "installation"
        && payload.get("action").and_then(Value::as_str) == Some("deleted")
    {
        on_uninstall(pool.get_ref(), &payload).await;
    }
    HttpResponse::Ok().json(serde_json::json!({ "ok": true, "event": event }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &str, body: &[u8]) -> String {
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).unwrap_or_else(|e| panic!("hmac: {e}"));
        mac.update(body);
        let bytes = mac.finalize().into_bytes();
        format!(
            "sha256={}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )
    }

    #[test]
    fn accepts_only_the_right_signature() {
        let body = br#"{"action":"opened"}"#;
        let good = sign("s3cret", body);
        assert!(signature_matches("s3cret", Some(&good), body));
        assert!(!signature_matches("other", Some(&good), body));
        assert!(!signature_matches("s3cret", Some(&good), b"{}"));
        assert!(!signature_matches("s3cret", None, body));
        assert!(!signature_matches("s3cret", Some("sha1=abc"), body));
        assert!(!signature_matches("s3cret", Some("sha256=zz"), body));
    }

    #[test]
    fn reads_pull_activity() {
        let payload = serde_json::json!({
            "action": "opened",
            "installation": { "id": 42 },
            "repository": { "full_name": "acme/api" },
            "pull_request": { "number": 7 }
        });
        assert_eq!(
            pull_activity(&payload),
            Some(PullActivity {
                installation_id: 42,
                repo: "acme/api".into(),
                number: Some(7),
                action: "opened".into(),
            })
        );
    }

    #[test]
    fn ignores_deliveries_without_an_installation_or_a_sane_repo() {
        let no_install = serde_json::json!({ "repository": { "full_name": "acme/api" } });
        assert_eq!(pull_activity(&no_install), None);
        let odd_repo = serde_json::json!({
            "installation": { "id": 42 },
            "repository": { "full_name": "acme/../api" }
        });
        assert_eq!(pull_activity(&odd_repo), None);
    }
}
