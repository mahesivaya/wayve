// Billing feature module. Covers both personal and organization billing. The
// local tables are a projection of Stripe, which remains the source of truth.
// Shared owner-resolution and authorization helpers live here so every submodule
// can reach them via `use super::...`.

pub mod catalog;
pub mod checkout;
pub mod entitlements;
pub mod invoices;
pub mod models;
pub mod organization_billing;
pub mod plans;
pub mod provider;
pub mod quotas;
pub mod routes;
pub mod subscriptions;
pub mod tiers;
pub mod usage_metering;
pub mod webhook_handler;

pub use routes::{public_routes, routes};

use crate::prelude::*;
use crate::routes::user::{
    effective_role_for_request, normalized_account_type, normalized_platform_role,
};
use models::BillingOwner;
use std::time::Duration;
use tracing::{error, info};
use wayve_security::jwt::get_user_id_from_request;

/// Extract the authenticated user id, or an Unauthorized response.
pub fn current_user(req: &HttpRequest) -> std::result::Result<i32, HttpResponse> {
    get_user_id_from_request(req).ok_or_else(|| HttpResponse::Unauthorized().finish())
}

/// `(account_type, organization_id)` for a user.
async fn account_row(
    pool: &PgPool,
    user_id: i32,
) -> std::result::Result<(String, Option<i32>), HttpResponse> {
    match sqlx::query_as::<_, (String, Option<i32>)>(
        "SELECT account_type, organization_id FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(HttpResponse::Unauthorized().finish()),
        Err(e) => {
            error!(target: "billing", user_id, error = ?e, "account lookup failed");
            Err(HttpResponse::InternalServerError().finish())
        }
    }
}

/// Resolve who is billed for this request. A user attached to an organization
/// is billed as that organization; everyone else is billed personally.
pub async fn resolve_owner(
    pool: &PgPool,
    user_id: i32,
) -> std::result::Result<BillingOwner, HttpResponse> {
    let (_, organization_id) = account_row(pool, user_id).await?;
    match organization_id {
        Some(org_id) => Ok(BillingOwner::Organization(org_id)),
        None => Ok(BillingOwner::User(user_id)),
    }
}

/// Mutating an organization's billing requires an organization or platform
/// admin; personal billing is always self-service.
pub async fn require_owner_manager(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
    owner: &BillingOwner,
) -> std::result::Result<(), HttpResponse> {
    if !owner.is_organization() {
        return Ok(());
    }
    let (account_type, _) = account_row(pool, user_id).await?;
    // Mode-aware: an owner browsing in normal mode is downscoped to member, and
    // managing org billing is an admin action, so it is refused.
    let (role, _) = effective_role_for_request(req, pool, user_id)
        .await
        .map_err(|e| {
            error!(target: "billing", user_id, error = ?e, "role lookup failed");
            HttpResponse::InternalServerError().finish()
        })?;

    if normalized_account_type(&account_type) == "platform_admin" {
        return match normalized_platform_role(&role) {
            "owner" | "admin" => Ok(()),
            _ => Err(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Platform owner or admin role required"
            }))),
        };
    }

    match role.as_str() {
        "owner" | "admin" => Ok(()),
        _ => Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only organization admins can manage organization billing"
        }))),
    }
}

/// Guard for platform-admin-only endpoints (plan catalog, global views).
pub async fn require_platform_admin(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> std::result::Result<(), HttpResponse> {
    let (account_type, _) = account_row(pool, user_id).await?;
    if normalized_account_type(&account_type) != "platform_admin" {
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Platform admin access required"
        })));
    }

    // Mode-aware: refused for a platform owner browsing in normal mode.
    let (role, _) = effective_role_for_request(req, pool, user_id)
        .await
        .map_err(|e| {
            error!(target: "billing", user_id, error = ?e, "platform role lookup failed");
            HttpResponse::InternalServerError().finish()
        })?;
    if matches!(normalized_platform_role(&role), "owner" | "admin") {
        Ok(())
    } else {
        Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Platform owner or admin role required"
        })))
    }
}

/// Periodic reconciliation that deactivates entitlements whose owner no longer
/// has an active subscription, catching cancellations whose webhook never
/// arrived. Idempotent, so it is safe to run on any cadence.
pub async fn spawn_billing_worker(pool: PgPool) {
    let mut ticks: u64 = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        ticks += 1;
        let result = sqlx::query(
            r#"
            UPDATE entitlements e
               SET active = false, updated_at = NOW()
             WHERE e.active = true
               AND NOT EXISTS (
                   SELECT 1 FROM subscriptions s
                    WHERE s.status IN ('active', 'trialing')
                      AND ((e.user_id IS NOT NULL AND s.user_id = e.user_id)
                        OR (e.organization_id IS NOT NULL
                            AND s.organization_id = e.organization_id))
               )
            "#,
        )
        .execute(&pool)
        .await;
        match result {
            Ok(done) => {
                if done.rows_affected() > 0 {
                    info!(target: "billing", deactivated = done.rows_affected(), "entitlement reconcile");
                }
            }
            Err(e) => {
                error!(target: "billing", tick = ticks, error = ?e, "entitlement reconcile failed")
            }
        }
    }
}

/// Link every paid plan lacking a `stripe_price_id` to a Stripe Price, creating
/// one if needed. Idempotent via the stable lookup_key, and best-effort: a Stripe
/// failure leaves the plan unlinked rather than crashing startup.
///
/// Gated on test mode so production never auto-creates prices; production plans
/// are hand-managed in the Stripe dashboard and linked into the DB by hand.
pub async fn ensure_test_prices(pool: &PgPool) {
    if !provider::is_configured() || !provider::is_test_mode() {
        return;
    }

    let plans: Vec<(String, String, i64)> = match sqlx::query_as(
        "SELECT code, name, amount_cents FROM plans \
         WHERE is_active = true \
           AND amount_cents > 0 \
           AND (stripe_price_id IS NULL OR stripe_price_id = '')",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!(target: "billing", error = ?e, "ensure_test_prices: plans lookup failed");
            return;
        }
    };

    for (code, name, amount_cents) in plans {
        let lookup_key = format!("rwayve_{code}_v1");

        let price_id = match provider::find_price_by_lookup_key(&lookup_key).await {
            Ok(Some(id)) => {
                info!(target: "billing", plan = %code, %id, "stripe price found by lookup_key");
                id
            }
            Ok(None) => {
                let product_id = match provider::create_product(&name, None).await {
                    Ok(id) => id,
                    Err(e) => {
                        error!(target: "billing", plan = %code, error = ?e, "create_product failed");
                        continue;
                    }
                };
                match provider::create_monthly_price(&product_id, amount_cents, "usd", &lookup_key)
                    .await
                {
                    Ok(id) => {
                        info!(target: "billing", plan = %code, %id, %product_id, "stripe price created");
                        id
                    }
                    Err(e) => {
                        error!(target: "billing", plan = %code, error = ?e, "create_monthly_price failed");
                        continue;
                    }
                }
            }
            Err(e) => {
                error!(target: "billing", plan = %code, error = ?e, "find_price_by_lookup_key failed");
                continue;
            }
        };

        if let Err(e) = sqlx::query("UPDATE plans SET stripe_price_id = $1 WHERE code = $2")
            .bind(&price_id)
            .bind(&code)
            .execute(pool)
            .await
        {
            error!(target: "billing", plan = %code, error = ?e, "ensure_test_prices: plan update failed");
        }
    }
}
