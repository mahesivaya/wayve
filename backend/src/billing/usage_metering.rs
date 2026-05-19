// Usage metering. Raw events land in `usage_events`; the Usage UI reads
// per-metric aggregates. Other feature modules call `record_event` to meter
// billable activity (emails sent, storage consumed, ...).

use super::models::{BillingOwner, RecordUsageInput};
use super::resolve_owner;
use crate::prelude::*;
use tracing::instrument;

/// Append a usage event for a billing owner.
pub async fn record_event(
    pool: &PgPool,
    owner: BillingOwner,
    metric: &str,
    quantity: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO usage_events (user_id, organization_id, metric, quantity)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .bind(metric)
    .bind(quantity)
    .execute(pool)
    .await?;
    Ok(())
}

#[post("/billing/usage")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn record_usage(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<RecordUsageInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };

    let metric = data.metric.trim();
    if metric.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "metric is required" })));
    }

    record_event(pool.get_ref(), owner, metric, data.quantity).await?;
    Ok(HttpResponse::Created().json(serde_json::json!({ "recorded": true })))
}

#[get("/billing/usage")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_usage(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };

    let rows = sqlx::query_as::<_, (String, i64, i64)>(
        r#"
        SELECT metric,
               COALESCE(SUM(quantity), 0)::BIGINT AS total,
               COUNT(*)::BIGINT AS events
          FROM usage_events
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
         GROUP BY metric
         ORDER BY metric
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_all(pool.get_ref())
    .await?;

    let metrics: Vec<_> = rows
        .into_iter()
        .map(|(metric, total, events)| {
            serde_json::json!({ "metric": metric, "total": total, "events": events })
        })
        .collect();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "owner_type": owner.kind(),
        "metrics": metrics,
    })))
}
