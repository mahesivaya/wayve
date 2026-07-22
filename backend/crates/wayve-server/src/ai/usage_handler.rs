//! AI usage and cost governance, backed by per-turn metering from
//! `ai_usage_events`. Every query is owner-scoped, so an org sees only its own
//! rows and the platform dashboard sees platform-scope rows. Gated by
//! `require_ai_owner`, like the config endpoints.

use crate::ai::config_handler::{AiOwner, require_ai_owner};
use crate::prelude::*;
use sqlx::Row;
use std::collections::HashMap;
use tracing::{error, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_usage);
    cfg.service(get_anthropic_cost);
}

#[get("/ai/usage")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_usage(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

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

    // The `($1 IS NULL AND organization_id IS NULL) OR organization_id = $1`
    // predicate below serves both dashboards from a single Option<i32> bind.
    let scope: Option<i32> = match owner {
        AiOwner::Org(org_id) => Some(org_id),
        AiOwner::Platform => None,
    };

    let totals = sqlx::query(
        "SELECT
           COUNT(*)::bigint                       AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(cost_micro_cents), 0)::bigint AS cost_micro,
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
    // Micro-cents summed losslessly, then divided once into fractional cents.
    let cost_cents: f64 = totals.get::<i64, _>("cost_micro") as f64 / 1_000_000.0;
    let active_users: i64 = totals.get("active_users");

    // generate_series zero-fills so the trend chart spans the full window.
    let daily: Vec<Value> = sqlx::query(
        "SELECT to_char(d.day, 'YYYY-MM-DD')       AS day,
                COUNT(e.id)::bigint                AS requests,
                COALESCE(SUM(e.cost_micro_cents), 0)::bigint AS cost_micro
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
            "cost_cents": r.get::<i64, _>("cost_micro") as f64 / 1_000_000.0,
        })
    })
    .collect();

    let by_model: Vec<Value> = sqlx::query(
        "SELECT model,
                COUNT(*)::bigint                     AS requests,
                COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cost_micro_cents), 0)::bigint AS cost_micro
           FROM ai_usage_events
          WHERE created_at >= NOW() - INTERVAL '30 days'
            AND (($1::int IS NULL AND organization_id IS NULL) OR organization_id = $1)
          GROUP BY model
          ORDER BY tokens DESC
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
            "tokens": r.get::<i64, _>("tokens"),
            "cost_cents": r.get::<i64, _>("cost_micro") as f64 / 1_000_000.0,
        })
    })
    .collect();

    // The name falls back through username to email so a row always has a label.
    let by_member: Vec<Value> = sqlx::query(
        "SELECT COALESCE(
                    NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
                    u.username,
                    u.email
                )                                    AS name,
                COUNT(*)::bigint                     AS requests,
                COALESCE(SUM(e.input_tokens + e.output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(e.cost_micro_cents), 0)::bigint AS cost_micro
           FROM ai_usage_events e
           JOIN users u ON u.id = e.user_id
          WHERE e.created_at >= NOW() - INTERVAL '30 days'
            AND (($1::int IS NULL AND e.organization_id IS NULL) OR e.organization_id = $1)
          GROUP BY u.id
          ORDER BY tokens DESC
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
            "tokens": r.get::<i64, _>("tokens"),
            "cost_cents": r.get::<i64, _>("cost_micro") as f64 / 1_000_000.0,
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
            "monthly_limit_cents": DEFAULT_MONTHLY_LIMIT_CENTS,
            "spent_cents": cost_cents,
            "alert_threshold_pct": 80,
        },
        "daily": daily,
        "by_model": by_model,
        "by_member": by_member,
    })))
}

/// Placeholder monthly cap (cents) until a real budget-config feature exists.
const DEFAULT_MONTHLY_LIMIT_CENTS: i64 = 20_000;

/// Authoritative spend from Anthropic's Admin Cost API. Platform-owner only: the
/// Cost API reports the whole Anthropic account, so showing it to an org owner
/// would leak cross-tenant spend. Anthropic attributes only by workspace, model,
/// and API key, so this complements rather than replaces the per-member view.
#[get("/ai/anthropic-cost")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_anthropic_cost(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;
    if !matches!(owner, AiOwner::Platform) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Authoritative Anthropic spend is available to the platform owner only."
        })));
    }

    let Some(admin_key) = std::env::var("ANTHROPIC_ADMIN_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
    else {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "configured": false })));
    };

    // Daily buckets are the Cost API's only granularity, and `limit=31` is needed
    // to get all 30 days in one page; the default page size is 7.
    let now = chrono::Utc::now();
    let start = now - chrono::Duration::days(30);
    let starting_at = start.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let ending_at = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let resp = Client::new()
        .get("https://api.anthropic.com/v1/organizations/cost_report")
        .query(&[
            ("starting_at", starting_at.as_str()),
            ("ending_at", ending_at.as_str()),
            ("group_by[]", "description"),
            ("limit", "31"),
        ])
        .header("x-api-key", admin_key.trim())
        .header("anthropic-version", "2023-06-01")
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            error!(target: "ai", error = %e, "anthropic cost report request failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Could not reach the Anthropic Cost API."
            })));
        }
    };
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        warn!(target: "ai", status, body = %body, "anthropic cost report returned non-2xx");
        return Ok(HttpResponse::BadGateway().json(serde_json::json!({
            "message": format!("Anthropic Cost API returned HTTP {status}.")
        })));
    }

    let payload: Value = resp.json().await.map_err(|e| {
        error!(target: "ai", error = %e, "anthropic cost report parse failed");
        AppError::internal("cost report parse failed")
    })?;

    // `amount` arrives as a decimal string of cents. Non-token line items have no
    // model, so they are labelled by cost_type instead.
    let mut total_cents = 0.0_f64;
    let mut by_model: HashMap<String, f64> = HashMap::new();
    for bucket in payload["data"].as_array().into_iter().flatten() {
        for item in bucket["results"].as_array().into_iter().flatten() {
            let amount = item["amount"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            total_cents += amount;
            let label = item["model"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| item["cost_type"].as_str())
                .unwrap_or("other");
            *by_model.entry(label.to_string()).or_insert(0.0) += amount;
        }
    }

    let mut by_model: Vec<Value> = by_model
        .into_iter()
        .map(|(model, cents)| serde_json::json!({ "model": model, "cost_cents": cents }))
        .collect();
    by_model.sort_by(|a, b| {
        b["cost_cents"]
            .as_f64()
            .partial_cmp(&a["cost_cents"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "configured": true,
        "period": "Last 30 days",
        "currency": "USD",
        "total_cents": total_cents,
        "by_model": by_model,
        // has_more should never be true at limit=31 over 30 days, but surface it
        // so the UI can flag a partial figure if it ever is.
        "truncated": payload["has_more"].as_bool().unwrap_or(false),
    })))
}
