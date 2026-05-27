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

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "event": event,
        "delivery": delivery
    })))
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
