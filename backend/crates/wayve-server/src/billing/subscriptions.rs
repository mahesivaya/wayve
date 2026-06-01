// Subscription read + cancellation. Local rows are a projection of Stripe
// state synced by webhooks; cancellation is forwarded to Stripe and mirrored
// locally so the UI updates immediately.

use super::provider;
use super::{require_owner_manager, resolve_owner};
use crate::prelude::*;
use chrono::{DateTime, Utc};
use tracing::{error, instrument};

#[get("/billing/subscription")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_subscription(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };

    let row = sqlx::query(
        r#"
        SELECT s.id, s.status, s.current_period_end, s.cancel_at_period_end,
               s.stripe_subscription_id,
               p.code AS plan_code, p.name AS plan_name,
               p.amount_cents, p.currency, p.billing_interval
          FROM subscriptions s
          LEFT JOIN plans p ON p.id = s.plan_id
         WHERE ($1::int IS NOT NULL AND s.user_id = $1)
            OR ($2::int IS NOT NULL AND s.organization_id = $2)
         ORDER BY s.updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool.get_ref())
    .await?;

    match row {
        Some(row) => {
            let period_end: Option<DateTime<Utc>> =
                row.try_get("current_period_end").ok().flatten();
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "owner_type": owner.kind(),
                "subscription": {
                    "id": row.get::<i32, _>("id"),
                    "status": row.get::<String, _>("status"),
                    "current_period_end": period_end,
                    "cancel_at_period_end": row.get::<bool, _>("cancel_at_period_end"),
                    "plan_code": row.try_get::<Option<String>, _>("plan_code").ok().flatten(),
                    "plan_name": row.try_get::<Option<String>, _>("plan_name").ok().flatten(),
                    "amount_cents": row.try_get::<Option<i64>, _>("amount_cents").ok().flatten(),
                    "currency": row.try_get::<Option<String>, _>("currency").ok().flatten(),
                    "billing_interval": row.try_get::<Option<String>, _>("billing_interval").ok().flatten(),
                }
            })))
        }
        None => Ok(HttpResponse::Ok().json(serde_json::json!({
            "owner_type": owner.kind(),
            "subscription": null,
        }))),
    }
}

#[instrument(target = "http", skip(req, pool))]
pub async fn cancel_subscription(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    let existing = sqlx::query_as::<_, (i32, Option<String>)>(
        r#"
        SELECT id, stripe_subscription_id
          FROM subscriptions
         WHERE status IN ('active', 'trialing')
           AND (($1::int IS NOT NULL AND user_id = $1)
             OR ($2::int IS NOT NULL AND organization_id = $2))
         ORDER BY updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool.get_ref())
    .await?;

    let (sub_id, stripe_id) = match existing {
        Some(row) => row,
        None => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "No active subscription" })));
        }
    };

    if let Some(stripe_id) = stripe_id.filter(|s| !s.is_empty())
        && let Err(e) = provider::cancel_at_period_end(&stripe_id).await
    {
        error!(target: "billing", error = ?e, "stripe cancel failed");
        return Ok(HttpResponse::BadGateway()
            .json(serde_json::json!({ "message": "Could not cancel with the payment provider" })));
    }

    sqlx::query(
        "UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1",
    )
    .bind(sub_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "cancel_at_period_end": true })))
}

#[get("/billing/admin/subscriptions")]
#[instrument(target = "http", skip(req, pool))]
pub async fn admin_list_subscriptions(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = super::require_platform_admin(pool.get_ref(), user_id).await {
        return Ok(resp);
    }

    let rows = sqlx::query(
        r#"
        SELECT s.id, s.user_id, s.organization_id, s.status,
               s.current_period_end, s.cancel_at_period_end, p.code AS plan_code
          FROM subscriptions s
          LEFT JOIN plans p ON p.id = s.plan_id
         ORDER BY s.updated_at DESC
         LIMIT 200
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let period_end: Option<DateTime<Utc>> =
                row.try_get("current_period_end").ok().flatten();
            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "user_id": row.try_get::<Option<i32>, _>("user_id").ok().flatten(),
                "organization_id": row.try_get::<Option<i32>, _>("organization_id").ok().flatten(),
                "status": row.get::<String, _>("status"),
                "current_period_end": period_end,
                "cancel_at_period_end": row.get::<bool, _>("cancel_at_period_end"),
                "plan_code": row.try_get::<Option<String>, _>("plan_code").ok().flatten(),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}
