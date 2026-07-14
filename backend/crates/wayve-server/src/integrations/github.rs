use crate::prelude::*;
use actix_web::http::header::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing::{info, warn};

type HmacSha256 = Hmac<Sha256>;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(github_webhook);
}

#[post("/integrations/github/webhook")]
async fn github_webhook(req: HttpRequest, body: web::Bytes) -> AppResult {
    verify_signature(req.headers(), &body)?;

    let event = header_value(req.headers(), "x-github-event").unwrap_or("unknown");
    let delivery = header_value(req.headers(), "x-github-delivery").unwrap_or("unknown");

    info!(
        target: "github",
        event,
        delivery,
        bytes = body.len(),
        "received GitHub webhook"
    );

    // Best-effort: a malformed payload or mail failure is logged but must never
    // fail the webhook, because GitHub retries non-2xx and would double-send.
    if event == "pull_request"
        && let Some(pr) = parse_opened_pull_request(&body)
    {
        notify_pull_request_opened(&pr).await;
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "event": event,
        "delivery": delivery
    })))
}

struct OpenedPull {
    number: i64,
    title: String,
    html_url: String,
    repo: String,
    author: String,
}

/// Only the `opened` action: reopened, synchronize, and edited are not a new PR.
fn parse_opened_pull_request(body: &[u8]) -> Option<OpenedPull> {
    let payload: serde_json::Value = serde_json::from_slice(body).ok()?;
    if payload.get("action").and_then(serde_json::Value::as_str) != Some("opened") {
        return None;
    }
    let pr = payload.get("pull_request")?;
    Some(OpenedPull {
        number: pr.get("number").and_then(serde_json::Value::as_i64)?,
        title: pr
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("(untitled)")
            .to_string(),
        html_url: pr
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        repo: payload
            .get("repository")
            .and_then(|repo| repo.get("full_name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown/unknown")
            .to_string(),
        author: pr
            .get("user")
            .and_then(|user| user.get("login"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    })
}

/// The recipient is configurable via `GITHUB_PR_NOTIFY_EMAIL`. Best-effort: a send
/// failure is logged, never propagated.
async fn notify_pull_request_opened(pr: &OpenedPull) {
    let to = crate::config::github_pr_notify_email();
    let app_link = format!(
        "{}/github",
        crate::config::frontend_url().trim_end_matches('/')
    );
    let subject = format!("New PR #{} — {}", pr.number, pr.title);
    let body = format!(
        "A new pull request was opened.\n\n\
         Repo:    {repo}\n\
         PR:      #{number} {title}\n\
         Author:  {author}\n\n\
         Open in code repo: {app_link}\n\
         View on GitHub:    {html_url}\n",
        repo = pr.repo,
        number = pr.number,
        title = pr.title,
        author = pr.author,
        html_url = pr.html_url,
    );

    match crate::email::sender::send_mail(&to, &subject, &body).await {
        Ok(()) => info!(target: "github", pr = pr.number, to = %to, "PR-opened email sent"),
        Err(error) => {
            warn!(target: "github", pr = pr.number, %error, "PR-opened email failed")
        }
    }
}

fn verify_signature(headers: &HeaderMap, body: &[u8]) -> std::result::Result<(), AppError> {
    let Ok(secret) = std::env::var("GITHUB_WEBHOOK_SECRET") else {
        warn!(
            target: "github",
            "GITHUB_WEBHOOK_SECRET is not set; accepting GitHub webhook without signature verification"
        );
        return Ok(());
    };

    if secret.trim().is_empty() {
        warn!(
            target: "github",
            "GITHUB_WEBHOOK_SECRET is empty; accepting GitHub webhook without signature verification"
        );
        return Ok(());
    }

    let signature = header_value(headers, "x-hub-signature-256")
        .ok_or_else(|| AppError::BadRequest("missing GitHub signature".to_string()))?;
    let signature = signature
        .strip_prefix("sha256=")
        .ok_or_else(|| AppError::BadRequest("invalid GitHub signature scheme".to_string()))?;
    let expected = decode_hex(signature)
        .ok_or_else(|| AppError::BadRequest("invalid GitHub signature".to_string()))?;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Internal("failed to initialize GitHub webhook verifier".into()))?;
    mac.update(body);
    mac.verify_slice(&expected)
        .map_err(|_| AppError::Unauthorized)?;

    Ok(())
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }

    input
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let high = hex_value(chunk[0])?;
            let low = hex_value(chunk[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opened_pull_request() {
        let payload = serde_json::json!({
            "action": "opened",
            "pull_request": {
                "number": 42,
                "title": "Add widget",
                "html_url": "https://github.com/acme/app/pull/42",
                "user": { "login": "octocat" }
            },
            "repository": { "full_name": "acme/app" }
        })
        .to_string();

        let pr = parse_opened_pull_request(payload.as_bytes())
            .unwrap_or_else(|| panic!("opened PR payload should parse"));
        assert_eq!(pr.number, 42);
        assert_eq!(pr.title, "Add widget");
        assert_eq!(pr.html_url, "https://github.com/acme/app/pull/42");
        assert_eq!(pr.repo, "acme/app");
        assert_eq!(pr.author, "octocat");
    }

    #[test]
    fn ignores_non_opened_actions() {
        let payload = serde_json::json!({
            "action": "synchronize",
            "pull_request": { "number": 7, "title": "x" }
        })
        .to_string();
        assert!(parse_opened_pull_request(payload.as_bytes()).is_none());
    }

    #[test]
    fn ignores_malformed_payload() {
        assert!(parse_opened_pull_request(b"not json").is_none());
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        // Only `action` + `pull_request.number` are required; everything else
        // falls back to a placeholder rather than dropping the notification.
        let payload = serde_json::json!({
            "action": "opened",
            "pull_request": { "number": 5 }
        })
        .to_string();

        let pr = parse_opened_pull_request(payload.as_bytes())
            .unwrap_or_else(|| panic!("minimal opened PR should still parse"));
        assert_eq!(pr.number, 5);
        assert_eq!(pr.title, "(untitled)");
        assert_eq!(pr.repo, "unknown/unknown");
        assert_eq!(pr.author, "unknown");
        assert_eq!(pr.html_url, "");
    }
}
