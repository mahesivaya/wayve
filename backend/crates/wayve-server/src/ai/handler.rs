use crate::ai::agent::ChatMsg;
use crate::ai::provider::resolve_ai_for_user;
use crate::prelude::*;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

#[derive(Deserialize)]
pub struct ChatTurn {
    /// "user" or "model"
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    /// Latest user message last. The caller owns ordering and token-limit trimming.
    pub messages: Vec<ChatTurn>,
}

/// The provider is resolved per request from the caller's organization; keys stay
/// server-side and never reach the browser.
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

    // Coercing the role means a misbehaving client can't break the request.
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

    // Metering is best-effort: a failure here must never fail the chat. The owner
    // scope mirrors provider resolution, so an org with its own enabled config owns
    // its members' usage and everyone else falls to platform scope.
    let owner_org: Option<i32> = sqlx::query_scalar(
        "SELECT u.organization_id FROM users u
           JOIN org_ai_configs c ON c.organization_id = u.organization_id
          WHERE u.id = $1 AND c.enabled",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await
    .ok()
    .flatten();
    // The dashboard aggregates micro-cents; cost_cents is a rounded legacy copy.
    let cost_micro_cents =
        crate::ai::agent::cost_micro_cents(&ai.model, result.input_tokens, result.output_tokens);
    let cost_cents = (cost_micro_cents + 500_000) / 1_000_000;
    if let Err(e) = sqlx::query(
        "INSERT INTO ai_usage_events
           (user_id, organization_id, provider, model, input_tokens, output_tokens, cost_cents, cost_micro_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(user_id)
    .bind(owner_org)
    .bind(ai.provider.as_str())
    .bind(&ai.model)
    .bind(result.input_tokens)
    .bind(result.output_tokens)
    .bind(cost_cents)
    .bind(cost_micro_cents)
    .execute(pool.get_ref())
    .await
    {
        warn!(target: "ai", error = ?e, "failed to record ai usage event");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "reply": result.reply,
        "tools_used": result.tools_used,
        "pending_actions": result.pending_actions,
        "provider": ai.provider.as_str(),
        "model": ai.model,
    })))
}

/// Returns only the provider id and model, never the API key, which is what makes
/// it safe for every authenticated user.
#[get("/ai/provider")]
#[instrument(target = "ai", skip(req, pool))]
pub async fn get_ai_provider(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let (provider, model) = match resolve_ai_for_user(pool.get_ref(), user_id).await? {
        Some(ai) => (Some(ai.provider.as_str()), Some(ai.model)),
        None => (None, None),
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "provider": provider,
        "model": model,
    })))
}
