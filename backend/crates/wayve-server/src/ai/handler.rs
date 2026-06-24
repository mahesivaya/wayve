use crate::prelude::*;
use tracing::{error, info, instrument};
use wayve_security::jwt::get_user_id_from_request;

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

/// POST /api/ai/chat — Gemini-backed assistant. The API key lives in
/// GEMINI_API_KEY on the server and is never exposed to the browser; auth is
/// JWT-gated like the rest of /api.
///
/// For an MCP owner (enterprise org / platform) with connected servers, the
/// request runs through `agent::run`, which declares those servers' tools to
/// Gemini and runs a bounded tool-call loop so the model can read the customer's
/// own systems. Everyone else gets the plain passthrough. The `pool` is needed
/// to resolve the caller's scope + connections.
#[post("/ai/chat")]
#[instrument(target = "ai", skip(req, pool, data), fields(turns = data.messages.len()))]
pub async fn ai_chat(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ChatRequest>,
) -> AppResult {
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

    let result = crate::ai::agent::run(pool.get_ref(), user_id, contents, &api_key, &model).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "reply": result.reply,
        "tools_used": result.tools_used,
    })))
}
