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
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

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

    // Owner scope for every metering query: an org sees only its own rows; the
    // platform dashboard sees platform-scope rows (organization_id IS NULL). The
    // predicate `(($1 IS NULL AND organization_id IS NULL) OR organization_id = $1)`
    // handles both from a single Option<i32> bind.
    let scope: Option<i32> = match owner {
        AiOwner::Org(org_id) => Some(org_id),
        AiOwner::Platform => None,
    };

    // Totals over the last 30 days.
    let totals = sqlx::query(
        "SELECT
           COUNT(*)::bigint                       AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(cost_cents), 0)::bigint   AS cost_cents,
           COUNT(DISTINCT user_id)::bigint        AS active_users
         FROM ai_usage_events
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND (($1::int IS NULL AND organization_id IS NULL) OR organization_id = $1)",
    )
    .bind(scope)
    .fetch_one(pool.get_ref())
    .await?;
    let requests: i64 = totals.get("requests");
    let input_tokens: i64 = totals.get("input_tokens");
    let output_tokens: i64 = totals.get("output_tokens");
    let cost_cents: i64 = totals.get("cost_cents");
    let active_users: i64 = totals.get("active_users");

    // 30-day cost/volume series, zero-filled via generate_series so the trend
    // chart always spans the full window even on quiet days.
    let daily: Vec<Value> = sqlx::query(
        "SELECT to_char(d.day, 'YYYY-MM-DD')       AS day,
                COUNT(e.id)::bigint                AS requests,
                COALESCE(SUM(e.cost_cents), 0)::bigint AS cost_cents
           FROM generate_series(
                  (CURRENT_DATE - INTERVAL '29 days')::date,
                  CURRENT_DATE::date,
                  INTERVAL '1 day') AS d(day)
           LEFT JOIN ai_usage_events e
             ON e.created_at >= d.day
            AND e.created_at <  d.day + INTERVAL '1 day'
            AND (($1::int IS NULL AND e.organization_id IS NULL) OR e.organization_id = $1)
          GROUP BY d.day
          ORDER BY d.day",
    )
    .bind(scope)
    .fetch_all(pool.get_ref())
    .await?
    .iter()
    .map(|r| {
        serde_json::json!({
            "day": r.get::<String, _>("day"),
            "requests": r.get::<i64, _>("requests"),
            "cost_cents": r.get::<i64, _>("cost_cents"),
        })
    })
    .collect();

    // Breakdown by model (top 10).
    let by_model: Vec<Value> = sqlx::query(
        "SELECT model,
                COUNT(*)::bigint                     AS requests,
                COALESCE(SUM(cost_cents), 0)::bigint AS cost_cents
           FROM ai_usage_events
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND (($1::int IS NULL AND organization_id IS NULL) OR organization_id = $1)
          GROUP BY model
          ORDER BY requests DESC
          LIMIT 10",
    )
    .bind(scope)
    .fetch_all(pool.get_ref())
    .await?
    .iter()
    .map(|r| {
        serde_json::json!({
            "model": r.get::<String, _>("model"),
            "requests": r.get::<i64, _>("requests"),
            "cost_cents": r.get::<i64, _>("cost_cents"),
        })
    })
    .collect();

    // Breakdown by member (top 10). Name falls back first→last, then username,
    // then email so a row always has a human label.
    let by_member: Vec<Value> = sqlx::query(
        "SELECT COALESCE(
                    NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
                    u.username,
                    u.email
                )                                    AS name,
                COUNT(*)::bigint                     AS requests,
                COALESCE(SUM(e.cost_cents), 0)::bigint AS cost_cents
           FROM ai_usage_events e
           JOIN users u ON u.id = e.user_id
          WHERE e.created_at >= NOW() - INTERVAL '30 days'
            AND (($1::int IS NULL AND e.organization_id IS NULL) OR e.organization_id = $1)
          GROUP BY u.id
          ORDER BY requests DESC
          LIMIT 10",
    )
    .bind(scope)
    .fetch_all(pool.get_ref())
    .await?
    .iter()
    .map(|r| {
        serde_json::json!({
            "name": r.get::<Option<String>, _>("name").unwrap_or_else(|| "Unknown".into()),
            "requests": r.get::<i64, _>("requests"),
            "cost_cents": r.get::<i64, _>("cost_cents"),
        })
    })
    .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "sample": false,
        "provider": provider,
        "model": model,
        "period": "Last 30 days",
        "totals": {
            "requests": requests,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_cents": cost_cents,
            "active_users": active_users,
        },
        "budget": {
            // No budget-config feature yet: show real month-to-date spend against
            // a default soft cap so the progress bar renders. Swap the limit for a
            // configurable value when budgets ship.
            "monthly_limit_cents": DEFAULT_MONTHLY_LIMIT_CENTS,
            "spent_cents": cost_cents,
            "alert_threshold_pct": 80,
        },
        "daily": daily,
        "by_model": by_model,
        "by_member": by_member,
    })))
}

/// Placeholder monthly budget cap (cents) until a real budget-config feature
/// exists. The dashboard renders spend-vs-cap against this.
const DEFAULT_MONTHLY_LIMIT_CENTS: i64 = 20_000;
