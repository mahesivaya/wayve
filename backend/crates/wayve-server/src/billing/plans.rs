// Plan catalog. Anyone signed in can read the active catalog; only platform
// admins may create / update / deactivate plans (they also paste in the
// Stripe price id). The same `admin_create_plan` upsert is the single
// write path — `code` is the immutable identity, everything else is
// mutable, and is_active defaults to true unless explicitly set false.

use super::models::{CreatePlanInput, Plan};
use crate::prelude::*;
use actix_web::delete;
use tracing::instrument;

const PLAN_COLUMNS: &str = "id, code, name, description, audience, tier, stripe_price_id, \
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

// Admin list — returns EVERY plan including deactivated ones, so the
// /settings/plans page can show the full catalog with active/inactive
// badges. Same RBAC gate as the upsert.
#[get("/billing/admin/plans")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn admin_list_plans(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = super::require_platform_admin(pool.get_ref(), user_id).await {
        return Ok(resp);
    }

    let query = format!("SELECT {PLAN_COLUMNS} FROM plans ORDER BY amount_cents");
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

    let tier = data.tier.as_deref().unwrap_or("personal");
    if !matches!(tier, "personal" | "startups" | "business" | "enterprise") {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "tier must be personal, startups, business, or enterprise"
        })));
    }

    // Features default to the empty JSON object so the column's NOT NULL
    // constraint stays happy on first insert. Admins pass a JSONB blob —
    // the simplest shape is `{ "End-to-end encrypted": true, "Custom domain": true }`
    // because the existing Pricing.tsx renderer iterates Object.entries.
    let features = data
        .features
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));

    // is_active behaviour:
    //   - omit → activate on create, leave EXISTING rows active (legacy
    //     behaviour, preserves the upsert-defaults-to-active intent).
    //   - true → activate.
    //   - false → deactivate (hide from /pricing without losing the row
    //     so historical subscriptions still resolve their plan_code).
    let is_active = data.is_active.unwrap_or(true);

    let query = format!(
        r#"
        INSERT INTO plans
            (code, name, description, audience, tier, stripe_price_id, amount_cents,
             currency, billing_interval, storage_limit_bytes, seat_limit,
             features, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            audience = EXCLUDED.audience,
            tier = EXCLUDED.tier,
            stripe_price_id = EXCLUDED.stripe_price_id,
            amount_cents = EXCLUDED.amount_cents,
            currency = EXCLUDED.currency,
            billing_interval = EXCLUDED.billing_interval,
            storage_limit_bytes = EXCLUDED.storage_limit_bytes,
            seat_limit = EXCLUDED.seat_limit,
            features = EXCLUDED.features,
            is_active = EXCLUDED.is_active
        RETURNING {PLAN_COLUMNS}
        "#
    );

    let plan = sqlx::query_as::<_, Plan>(&query)
        .bind(code)
        .bind(name)
        .bind(data.description.as_deref())
        .bind(audience)
        .bind(tier)
        .bind(data.stripe_price_id.as_deref())
        .bind(data.amount_cents.unwrap_or(0))
        .bind(data.currency.as_deref().unwrap_or("usd"))
        .bind(data.billing_interval.as_deref().unwrap_or("month"))
        .bind(data.storage_limit_bytes.unwrap_or(0))
        .bind(data.seat_limit.unwrap_or(1))
        .bind(&features)
        .bind(is_active)
        .fetch_one(pool.get_ref())
        .await?;

    Ok(HttpResponse::Created().json(plan))
}

// Soft-delete by code. The row stays so historical subscriptions that
// reference it stay resolvable; it just drops off /pricing and the
// public list_plans response. Idempotent — no-op on rows already
// is_active=false, 404 only when the code never existed.
#[delete("/billing/admin/plans/{code}")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn admin_deactivate_plan(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = super::require_platform_admin(pool.get_ref(), user_id).await {
        return Ok(resp);
    }

    let code = path.into_inner();
    let result = sqlx::query("UPDATE plans SET is_active = false WHERE code = $1")
        .bind(&code)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Plan not found" }))
        );
    }

    Ok(HttpResponse::NoContent().finish())
}
