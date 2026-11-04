// Organization plans are priced per user, so the Stripe subscription's quantity
// follows the org's user count. A change syncs right away from the handler that
// made it, and the billing worker re-checks every org hourly, so a Stripe outage
// or a missed path corrects itself. Stripe prorates a mid-period change onto the
// next invoice.

use super::models::BillingOwner;
use super::provider;
use crate::prelude::*;
use tracing::{error, info};

/// Users the org pays for. A SCIM-deprovisioned user (`guest`) keeps their row but
/// is no longer billed. Never below 1: Stripe rejects a zero quantity.
pub async fn billable_seats(pool: &PgPool, org_id: i32) -> std::result::Result<i64, sqlx::Error> {
    let seats: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM users \
         WHERE organization_id = $1 AND account_type <> 'guest'",
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    Ok(seats.max(1))
}

/// The quantity to start a subscription with: per user for an org, 1 otherwise.
pub async fn subscription_quantity(
    pool: &PgPool,
    owner: BillingOwner,
) -> std::result::Result<i64, sqlx::Error> {
    match owner.organization_id() {
        Some(org_id) => billable_seats(pool, org_id).await,
        None => Ok(1),
    }
}

/// Set the org's paid subscription to its current user count. Never fails the
/// caller: the user change has already happened, and the worker retries this.
pub async fn sync_org_seats(pool: &PgPool, org_id: i32) {
    if !provider::is_configured() {
        return;
    }
    if let Err(e) = try_sync_org_seats(pool, org_id).await {
        error!(target: "billing", org_id, error = ?e, "seat sync failed");
    }
}

async fn try_sync_org_seats(pool: &PgPool, org_id: i32) -> Result<()> {
    // Ignores a subscription with no Stripe id, such as an admin-granted one.
    let subscription: Option<String> = sqlx::query_scalar(
        "SELECT s.stripe_subscription_id FROM subscriptions s \
           JOIN plans p ON p.id = s.plan_id \
          WHERE s.organization_id = $1 AND p.amount_cents > 0 \
            AND s.stripe_subscription_id IS NOT NULL \
            AND s.status IN ('active', 'trialing', 'past_due') \
          ORDER BY s.updated_at DESC LIMIT 1",
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?;
    let Some(subscription) = subscription else {
        return Ok(());
    };

    let seats = billable_seats(pool, org_id).await?;
    if provider::set_subscription_quantity(&subscription, seats).await? {
        info!(target: "billing", org_id, seats, "subscription seats updated");
    }
    Ok(())
}

/// Hourly backstop for `sync_org_seats`.
pub async fn reconcile_org_seats(pool: &PgPool) {
    if !provider::is_configured() {
        return;
    }
    let orgs: Vec<i32> = match sqlx::query_scalar(
        "SELECT DISTINCT s.organization_id FROM subscriptions s \
           JOIN plans p ON p.id = s.plan_id \
          WHERE s.organization_id IS NOT NULL AND p.amount_cents > 0 \
            AND s.stripe_subscription_id IS NOT NULL \
            AND s.status IN ('active', 'trialing', 'past_due')",
    )
    .fetch_all(pool)
    .await
    {
        Ok(orgs) => orgs,
        Err(e) => {
            error!(target: "billing", error = ?e, "seat reconcile lookup failed");
            return;
        }
    };
    for org_id in orgs {
        sync_org_seats(pool, org_id).await;
    }
}
