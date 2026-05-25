// Tier comparison + per-user quota endpoints.
//
// `GET /api/billing/tiers` is public (no auth) so the marketing /developers
// portal can render the comparison table without a session. It serves the
// rate-limit dimensions only — the price + storage live on /api/billing/plans
// and the two endpoints are intentionally kept separate so a checkout UI
// doesn't accidentally couple to the rate-limit columns.

use super::quotas;
use crate::cache::Cache;
use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;
use sqlx::Row;
use tracing::instrument;

#[get("/billing/tiers")]
#[instrument(target = "http", skip(pool))]
pub async fn list_tiers(pool: web::Data<PgPool>) -> AppResult {
    let rows = sqlx::query(
        r#"
        SELECT code, name, audience, amount_cents, currency, billing_interval,
               rate_limit_per_min, monthly_quota
          FROM plans
         WHERE is_active = true
         ORDER BY amount_cents
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "code": row.try_get::<String, _>("code").unwrap_or_default(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "audience": row.try_get::<String, _>("audience").unwrap_or_default(),
                "amount_cents": row.try_get::<i64, _>("amount_cents").unwrap_or(0),
                "currency": row.try_get::<String, _>("currency").unwrap_or_default(),
                "billing_interval": row.try_get::<String, _>("billing_interval").unwrap_or_default(),
                "rate_limit_per_min": row.try_get::<i32, _>("rate_limit_per_min").unwrap_or(60),
                "monthly_quota": row.try_get::<i32, _>("monthly_quota").unwrap_or(50_000),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[get("/billing/quota")]
#[instrument(target = "http", skip(req, pool, cache))]
pub async fn get_quota(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let tier = quotas::effective_for_user(pool.get_ref(), user_id).await;

    // Current month's request count lives in Redis; if Redis is down we
    // surface NULL rather than a misleading zero.
    let used: Option<i64> = match cache.get_ref().clone() {
        Some(c) => {
            let key = quotas::monthly_quota_key(user_id);
            c.get_counter(&key).await
        }
        None => None,
    };

    let cycle_end = next_month_start();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "plan_code": tier.plan_code,
        "plan_name": tier.plan_name,
        "rate_limit_per_min": tier.rate_limit_per_min,
        "monthly_quota": tier.monthly_quota,
        "monthly_used": used,
        "monthly_remaining": tier.monthly_quota.checked_sub(used.unwrap_or(0) as i32),
        "cycle_resets_at": cycle_end,
    })))
}

fn next_month_start() -> chrono::DateTime<chrono::Utc> {
    use chrono::{Datelike, NaiveDate, TimeZone};
    let now = chrono::Utc::now();
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|naive| chrono::Utc.from_utc_datetime(&naive))
        .unwrap_or(now)
}
