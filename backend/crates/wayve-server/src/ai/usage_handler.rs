//! AI usage & cost governance — owner-only dashboard data. **Sample data only**
//! for now (`sample: true`); real metering is phase-2. Shaped so a later swap to
//! real numbers is a drop-in replacement for `sample_usage`. Gated exactly like
//! the config endpoints (enterprise owner) via `require_ai_owner`.

use crate::ai::config_handler::{AiOwner, require_ai_owner};
use crate::prelude::*;
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_usage);
}

#[get("/ai/usage")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_usage(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(pool.get_ref(), user_id).await?;

    // Label the dashboard with the owner's actual provider/model when configured.
    let row = match owner {
        AiOwner::Org(org_id) => {
            sqlx::query("SELECT provider, model FROM org_ai_configs WHERE organization_id = $1")
                .bind(org_id)
                .fetch_optional(pool.get_ref())
                .await?
        }
        AiOwner::Platform => {
            sqlx::query("SELECT provider, model FROM platform_ai_config WHERE id = 1")
                .fetch_optional(pool.get_ref())
                .await?
        }
    };
    let provider = row
        .as_ref()
        .map(|r| r.get::<String, _>("provider"))
        .unwrap_or_else(|| "gemini".to_string());
    let model = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("model").ok().flatten());

    Ok(HttpResponse::Ok().json(sample_usage(&provider, model.as_deref())))
}

/// Deterministic placeholder usage. Replace the body with a real query over a
/// metering table in phase-2 — the JSON shape is the contract the frontend reads.
fn sample_usage(provider: &str, model: Option<&str>) -> Value {
    // A simple 30-day cost series (deterministic, no clock/RNG needed).
    let daily: Vec<Value> = (1..=30)
        .map(|d| {
            let requests = 40 + (d * 7) % 90;
            let cost_cents = 120 + (d * 13) % 400;
            serde_json::json!({
                "day": format!("2026-06-{d:02}"),
                "requests": requests,
                "cost_cents": cost_cents,
            })
        })
        .collect();

    serde_json::json!({
        "sample": true,
        "provider": provider,
        "model": model,
        "period": "Last 30 days",
        "totals": {
            "requests": 2143,
            "input_tokens": 4_812_990,
            "output_tokens": 1_233_104,
            "cost_cents": 7421,
            "active_users": 18,
        },
        "budget": {
            "monthly_limit_cents": 20000,
            "spent_cents": 7421,
            "alert_threshold_pct": 80,
        },
        "daily": daily,
        "by_model": [
            { "model": model.unwrap_or("claude-opus-4-8"), "requests": 1680, "cost_cents": 6120 },
            { "model": "claude-haiku-4-5", "requests": 463, "cost_cents": 1301 },
        ],
        "by_member": [
            { "name": "Priya N.",  "requests": 612, "cost_cents": 2410 },
            { "name": "Marcus L.", "requests": 388, "cost_cents": 1502 },
            { "name": "Dana W.",   "requests": 274, "cost_cents": 998 },
            { "name": "Sam O.",    "requests": 201, "cost_cents": 760 },
        ],
    })
}
