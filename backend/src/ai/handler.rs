use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use tracing::{error, info, instrument, warn};

#[derive(Deserialize)]
pub struct ChatTurn {
    /// "user" or "model"
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    /// Full conversation history including the latest user message at the end.
    /// Caller is responsible for ordering and trimming for token limits.
    pub messages: Vec<ChatTurn>,
}

/// POST /api/ai/chat — proxies to Google's Generative Language API
/// (Gemini). The API key lives in GEMINI_API_KEY on the server and is
/// never exposed to the browser. Auth is JWT-gated like the rest of /api.
#[post("/ai/chat")]
#[instrument(target = "ai", skip(req, data), fields(turns = data.messages.len()))]
pub async fn ai_chat(req: HttpRequest, data: web::Json<ChatRequest>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let api_key = match crate::config::gemini_api_key() {
        Some(key) => key,
        None => {
            error!("GEMINI_API_KEY missing");
            return Ok(HttpResponse::InternalServerError()
                .body("AI not configured (GEMINI_API_KEY missing)"));
        }
    };

    info!(
        "AI chat request: user_id={} turns={}",
        user_id,
        data.messages.len()
    );

    let model = crate::config::gemini_model();

    // Map our {role, content} turns to Gemini's {role, parts:[{text}]} shape.
    // Gemini accepts roles "user" and "model"; anything else gets coerced
    // to "user" so a wrong client doesn't 400 the whole request.
    let contents: Vec<Value> = data
        .messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .map(|m| {
            let role = if m.role == "model" { "model" } else { "user" };
            serde_json::json!({
                "role": role,
                "parts": [{ "text": m.content }],
            })
        })
        .collect();

    if contents.is_empty() {
        return Ok(HttpResponse::BadRequest().body("Empty conversation"));
    }

    let url = format!(
        "{}/v1beta/models/{}:generateContent?key={}",
        crate::external::gemini_base(),
        model,
        api_key
    );

    let body = serde_json::json!({ "contents": contents });

    let res = HTTP_CLIENT.post(&url).json(&body).send().await;

    let res = match res {
        Ok(r) => r,
        Err(e) => {
            error!("Gemini upstream transport error: {}", e);
            return Ok(HttpResponse::BadGateway().body("Upstream error"));
        }
    };

    let status = res.status();
    let payload: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            error!("Gemini json parse failed: {}", e);
            return Ok(HttpResponse::BadGateway().body("Bad upstream response"));
        }
    };

    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("Upstream error")
            .to_string();
        warn!("Gemini non-2xx: {} - {}", status, msg);
        return Ok(HttpResponse::BadGateway().body(msg));
    }

    // Stitch together every text part of the first candidate. Gemini may
    // split a single response across multiple parts (e.g. when grounding
    // metadata is mixed in).
    let reply = payload["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    Ok(HttpResponse::Ok().json(serde_json::json!({ "reply": reply })))
}
