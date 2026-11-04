// Self-serve upgrade from a personal account to an organization. The user becomes
// the new org's owner; their data stays theirs. The free plan upgrades on the
// spot. A paid plan parks the org details in `pending_org_signups` and creates
// the org only once Stripe reports the subscription paid: the client calls
// finalize after confirming, and the webhook is the backstop if the browser
// closed first.

use super::checkout::{actor_email, ensure_customer};
use super::entitlements::refresh_entitlements;
use super::models::{BillingOwner, OrganizationUpgradeInput};
use super::provider;
use crate::email::profile::invalidate_me_cache;
use crate::prelude::*;
use crate::routes::user::{
    create_org_for_user, finalize_org_signup_inner, invalidate_profile_cache, lock_if_personal,
};
use tracing::{error, instrument, warn};
use wayve_security::rbac;

const NOT_PERSONAL: &str = "Your account already belongs to an organization or platform scope";

fn message(text: &str) -> serde_json::Value {
    serde_json::json!({ "message": text })
}

fn name_taken(name: &str) -> HttpResponse {
    HttpResponse::Conflict().json(serde_json::json!({
        "message": format!("An organization named '{name}' already exists")
    }))
}

/// Same match as the `organizations` unique indexes, so a taken name is refused
/// before payment rather than discovered after it.
async fn org_name_exists(pool: &PgPool, name: &str) -> std::result::Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM organizations \
          WHERE name = $1 OR slug = lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')))",
    )
    .bind(name)
    .fetch_one(pool)
    .await
}

#[post("/billing/organization-upgrade")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn start_organization_upgrade(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<OrganizationUpgradeInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let name = data.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Ok(
            HttpResponse::BadRequest().json(message("Enter an organization name (max 120 chars)"))
        );
    }

    let (account_type, organization_id) = match super::account_row(pool.get_ref(), user_id).await {
        Ok(row) => row,
        Err(resp) => return Ok(resp),
    };
    if account_type != "personal" || organization_id.is_some() {
        return Ok(HttpResponse::Conflict().json(message(NOT_PERSONAL)));
    }

    // Enterprise stays sales-led, so it is deliberately not self-serve.
    let plan = sqlx::query_as::<_, (Option<String>, i64)>(
        "SELECT stripe_price_id, amount_cents FROM plans \
         WHERE code = $1 AND audience = 'organization' AND tier <> 'enterprise' \
           AND is_active = true",
    )
    .bind(data.plan_code.trim())
    .fetch_optional(pool.get_ref())
    .await?;
    let Some((price_id, amount_cents)) = plan else {
        return Ok(HttpResponse::BadRequest().json(message(
            "This plan is not available as a self-serve upgrade",
        )));
    };

    // A personal subscription would keep charging after billing moves to the
    // org, with nothing in the app left to cancel it from.
    let has_personal_subscription: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM subscriptions \
          WHERE user_id = $1 AND stripe_subscription_id IS NOT NULL \
            AND status IN ('active', 'trialing', 'past_due') \
            AND NOT cancel_at_period_end)",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;
    if has_personal_subscription {
        return Ok(HttpResponse::Conflict().json(message(
            "Cancel your personal plan before upgrading to an organization",
        )));
    }

    if org_name_exists(pool.get_ref(), name).await? {
        return Ok(name_taken(name));
    }

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return Ok(resp),
    };

    if amount_cents == 0 {
        return upgrade_to_free_plan(&req, pool.get_ref(), user_id, (name, &email)).await;
    }

    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable().json(message("Billing is not configured")));
    }
    let Some(price_id) = price_id.filter(|p| !p.is_empty()) else {
        return Ok(HttpResponse::BadRequest()
            .json(message("This plan is not linked to a Stripe price yet")));
    };
    // Billed to the personal customer, which finalize then links to the org.
    let customer_id =
        match ensure_customer(pool.get_ref(), BillingOwner::User(user_id), &email).await {
            Ok(id) => id,
            Err(resp) => return Ok(resp),
        };

    // The row needs the subscription id (NOT NULL) and the subscription needs the
    // row id (its metadata), so reserve the id first.
    let pending_id: i32 = sqlx::query_scalar(
        "SELECT nextval(pg_get_serial_sequence('pending_org_signups', 'id'))::int",
    )
    .fetch_one(pool.get_ref())
    .await?;
    let pending = match provider::create_org_upgrade_subscription(
        &customer_id,
        &price_id,
        pending_id,
    )
    .await
    {
        Ok(pending) => pending,
        Err(e) => {
            error!(target: "billing", user_id, error = ?e, "org upgrade subscription create failed");
            return Ok(HttpResponse::BadGateway().json(message("Could not start subscription")));
        }
    };
    sqlx::query(
        "INSERT INTO pending_org_signups \
            (id, user_id, name, admin_email, plan_code, stripe_customer_id, stripe_subscription_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(pending_id)
    .bind(user_id)
    .bind(name)
    .bind(&email)
    .bind(data.plan_code.trim())
    .bind(&customer_id)
    .bind(&pending.subscription_id)
    .execute(pool.get_ref())
    .await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "checkout_started",
            resource_type: "plan",
            resource_id: Some(data.plan_code.trim().to_string()),
            metadata: Some(serde_json::json!({ "flow": "organization_upgrade" })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "pending_id": pending_id,
        "client_secret": pending.client_secret,
        "publishable_key": provider::publishable_key(),
    })))
}

async fn upgrade_to_free_plan(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
    (name, email): (&str, &str),
) -> AppResult {
    let mut tx = pool.begin().await?;
    if !lock_if_personal(&mut tx, user_id).await? {
        return Ok(HttpResponse::Conflict().json(message(NOT_PERSONAL)));
    }
    let Some(org_id) = create_org_for_user(&mut tx, user_id, name, None, Some(email)).await? else {
        return Ok(name_taken(name));
    };
    tx.commit().await?;

    // Replaces the starter seed with the free plan's own limits.
    if let Err(e) = refresh_entitlements(pool, BillingOwner::Organization(org_id)).await {
        error!(target: "billing", org_id, error = ?e, "entitlement refresh failed after org upgrade");
    }
    invalidate_profile_cache(user_id).await;
    invalidate_me_cache(user_id).await;
    rbac::invalidate_role_context(user_id).await;

    crate::audit::record_action(
        pool,
        req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "organization_upgraded",
            resource_type: "organization",
            resource_id: Some(org_id.to_string()),
            metadata: Some(serde_json::json!({ "flow": "free" })),
        },
    )
    .await;

    Ok(HttpResponse::Created().json(serde_json::json!({ "organization_id": org_id })))
}

/// Called after the client confirms payment. Idempotent, and verifies the charge
/// with Stripe rather than trusting the caller.
#[post("/billing/organization-upgrade/{pending_id}/finalize")]
#[instrument(target = "http", skip(req, pool))]
pub async fn finalize_organization_upgrade(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let pending_id = path.into_inner();

    let row = sqlx::query_as::<_, (String, String, Option<i32>)>(
        "SELECT stripe_subscription_id, status, organization_id FROM pending_org_signups \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(pending_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    // Another user's upgrade answers the same as a missing one.
    let Some((subscription_id, status, organization_id)) = row else {
        return Ok(HttpResponse::NotFound().json(message("Upgrade not found")));
    };

    if status == "finalized" {
        return Ok(
            HttpResponse::Ok().json(serde_json::json!({ "organization_id": organization_id }))
        );
    }
    if status == "failed" {
        return Ok(HttpResponse::Conflict().json(message(
            "This upgrade could not be completed. Please contact support.",
        )));
    }

    match provider::get_subscription_status(&subscription_id).await {
        Ok(status) if status == "active" || status == "trialing" => {}
        Ok(_) => {
            // Stripe can mark the invoice paid just after the card confirms, so
            // this is "not yet", not a failure: the client polls.
            return Ok(
                HttpResponse::Accepted().json(serde_json::json!({ "organization_id": null }))
            );
        }
        Err(e) => {
            error!(target: "billing", pending_id, error = ?e, "subscription status lookup failed");
            return Ok(HttpResponse::BadGateway().json(message("Could not verify payment")));
        }
    }

    match finalize_org_signup_inner(pool.get_ref(), pending_id).await? {
        Some(org_id) => {
            crate::audit::record_action(
                pool.get_ref(),
                &req,
                crate::audit::AuditEvent {
                    actor_user_id: user_id,
                    action: "organization_upgraded",
                    resource_type: "organization",
                    resource_id: Some(org_id.to_string()),
                    metadata: Some(serde_json::json!({ "flow": "paid" })),
                },
            )
            .await;
            Ok(HttpResponse::Ok().json(serde_json::json!({ "organization_id": org_id })))
        }
        None => {
            // Paid, but no org could be created: stop further charges.
            if let Err(e) = provider::cancel_now(&subscription_id).await {
                warn!(target: "billing", pending_id, error = ?e, "cancel after failed org upgrade failed");
            }
            Ok(HttpResponse::Conflict().json(message(
                "Your payment went through but the organization could not be created. \
                 Please contact support for a refund.",
            )))
        }
    }
}
