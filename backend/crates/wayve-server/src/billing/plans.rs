// Plan catalog. Anyone signed in can read the catalog; only platform admins
// may create or update plans (they also paste in the Stripe price id).

use super::models::{CreatePlanInput, Plan};
use crate::prelude::*;
use tracing::instrument;

const PLAN_COLUMNS: &str = "id, code, name, description, audience, stripe_price_id, \
    amount_cents, currency, billing_interval, storage_limit_bytes, seat_limit, \
    features, is_active";

#[get("/billing/plans")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_plans(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = super::current_user(&req) {
        return Ok(resp);
    }

    let query =
        format!("SELECT {PLAN_COLUMNS} FROM plans WHERE is_active = true ORDER BY amount_cents");
    let plans = sqlx::query_as::<_, Plan>(&query)
        .fetch_all(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(plans))
}

#[post("/billing/admin/plans")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn admin_create_plan(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreatePlanInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = super::require_platform_admin(pool.get_ref(), user_id).await {
        return Ok(resp);
    }

    let code = data.code.trim();
    let name = data.name.trim();
    if code.is_empty() || name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "code and name are required" })));
    }

    let audience = data.audience.as_deref().unwrap_or("personal");
    if !matches!(audience, "personal" | "organization") {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "audience must be personal or organization" })));
    }

    let query = format!(
        r#"
        INSERT INTO plans
            (code, name, description, audience, stripe_price_id, amount_cents,
             currency, billing_interval, storage_limit_bytes, seat_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            audience = EXCLUDED.audience,
            stripe_price_id = EXCLUDED.stripe_price_id,
            amount_cents = EXCLUDED.amount_cents,
            currency = EXCLUDED.currency,
            billing_interval = EXCLUDED.billing_interval,
            storage_limit_bytes = EXCLUDED.storage_limit_bytes,
            seat_limit = EXCLUDED.seat_limit,
            is_active = true
        RETURNING {PLAN_COLUMNS}
        "#
    );

    let plan = sqlx::query_as::<_, Plan>(&query)
        .bind(code)
        .bind(name)
        .bind(data.description.as_deref())
        .bind(audience)
        .bind(data.stripe_price_id.as_deref())
        .bind(data.amount_cents.unwrap_or(0))
        .bind(data.currency.as_deref().unwrap_or("usd"))
        .bind(data.billing_interval.as_deref().unwrap_or("month"))
        .bind(data.storage_limit_bytes.unwrap_or(0))
        .bind(data.seat_limit.unwrap_or(1))
        .fetch_one(pool.get_ref())
        .await?;

    Ok(HttpResponse::Created().json(plan))
}
