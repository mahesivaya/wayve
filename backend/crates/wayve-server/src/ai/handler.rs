use crate::ai::agent::ChatMsg;
use crate::ai::provider::resolve_ai_for_user;
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

/// POST /api/ai/chat — the assistant. The provider is resolved per request from
/// the caller's organization: an enterprise org runs on the owner-selected
/// provider (Gemini / Anthropic / OpenAI-compatible), everyone else on the
/// platform default (Gemini). Keys live server-side and never reach the browser;
/// auth is JWT-gated like the rest of /api.
///
/// For an MCP owner (enterprise org / platform) with connected servers, the
/// request runs through `agent::run`, which declares those servers' tools and runs
/// a bounded tool-call loop so the model can read the customer's own systems.
#[post("/ai/chat")]
#[instrument(target = "ai", skip(req, pool, data), fields(turns = data.messages.len()))]
pub async fn ai_chat(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ChatRequest>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let ai = match resolve_ai_for_user(pool.get_ref(), user_id).await? {
        Some(ai) => ai,
        None => {
            error!("no AI provider configured (org config absent and GEMINI_API_KEY missing)");
            return Ok(HttpResponse::InternalServerError().body("AI not configured"));
        }
    };

    info!(
        "AI chat request: user_id={} turns={} provider={}",
        user_id,
        data.messages.len(),
        ai.provider.as_str()
    );

    // Normalize turns: drop blanks, coerce role to "user"/"model" so a wrong
    // client can't break the request. Each provider maps these to its own shape.
    let msgs: Vec<ChatMsg> = data
        .messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .map(|m| ChatMsg {
            role: if m.role == "model" { "model" } else { "user" }.to_string(),
            content: m.content.clone(),
        })
        .collect();

    if msgs.is_empty() {
        return Ok(HttpResponse::BadRequest().body("Empty conversation"));
    }

    let result = crate::ai::agent::run(pool.get_ref(), user_id, msgs, &ai).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "reply": result.reply,
        "tools_used": result.tools_used,
        "provider": ai.provider.as_str(),
        "model": ai.model,
    })))
}
