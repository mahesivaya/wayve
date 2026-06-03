// Checkout + Customer Portal. Subscriptions are created through Stripe's
// hosted Checkout; payment-method changes and invoice history are delegated
// to Stripe's hosted Customer Portal. Both endpoints return a URL for the
// frontend to redirect to.

use super::models::{BillingOwner, CheckoutInput, DefaultPaymentMethodInput};
use super::provider::{self, CheckoutParams};
use super::{require_owner_manager, resolve_owner};
use crate::prelude::*;
use tracing::{error, instrument};

fn owner_id(owner: BillingOwner) -> i32 {
    owner
        .user_id()
        .or_else(|| owner.organization_id())
        .unwrap_or(0)
}

fn frontend_url() -> String {
    crate::config::frontend_url()
}

/// Fetch the requesting user's email — used as the Stripe customer contact.
async fn actor_email(pool: &PgPool, user_id: i32) -> std::result::Result<String, HttpResponse> {
    match sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
    {
        Ok(Some(email)) => Ok(email),
        Ok(None) => Err(HttpResponse::Unauthorized().finish()),
        Err(e) => {
            error!(target: "billing", user_id, error = ?e, "actor email lookup failed");
            Err(HttpResponse::InternalServerError().finish())
        }
    }
}

/// Return the owner's Stripe customer id, creating the customer (and the
/// `billing_customers` row) on first use.
async fn ensure_customer(
    pool: &PgPool,
    owner: BillingOwner,
    email: &str,
) -> std::result::Result<String, HttpResponse> {
    let existing = sqlx::query_scalar::<_, String>(
        r#"
        SELECT stripe_customer_id FROM billing_customers
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool)
    .await;

    match existing {
        Ok(Some(id)) => return Ok(id),
        Ok(None) => {}
        Err(e) => {
            error!(target: "billing", error = ?e, "billing customer lookup failed");
            return Err(HttpResponse::InternalServerError().finish());
        }
    }

    let label = format!("{}:{}", owner.kind(), owner_id(owner));
    let customer_id = match provider::create_customer(email, &label).await {
        Ok(id) => id,
        Err(e) => {
            error!(target: "billing", error = ?e, "stripe customer create failed");
            return Err(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not reach the payment provider" })));
        }
    };

    if let Err(e) = sqlx::query(
        "INSERT INTO billing_customers (user_id, organization_id, stripe_customer_id)
         VALUES ($1, $2, $3)",
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .bind(&customer_id)
    .execute(pool)
    .await
    {
        error!(target: "billing", error = ?e, "billing customer insert failed");
        return Err(HttpResponse::InternalServerError().finish());
    }

    Ok(customer_id)
}

#[post("/billing/checkout")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_checkout(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CheckoutInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    // Resolve the requested plan and confirm it is purchasable by this owner.
    let plan = sqlx::query_as::<_, (i32, Option<String>, String)>(
        "SELECT id, stripe_price_id, audience FROM plans WHERE code = $1 AND is_active = true",
    )
    .bind(data.plan_code.trim())
    .fetch_optional(pool.get_ref())
    .await?;

    let (plan_id, price_id, audience) = match plan {
        Some(row) => row,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Unknown plan" }))
            );
        }
    };

    if audience != owner.kind() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": format!("This plan is for {audience} accounts")
        })));
    }
    let Some(price_id) = price_id.filter(|p| !p.is_empty()) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "This plan is not linked to a Stripe price yet"
        })));
    };

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return Ok(resp),
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let base = frontend_url();
    let params = CheckoutParams {
        customer_id,
        price_id,
        success_url: format!("{base}/billing?checkout=success"),
        cancel_url: format!("{base}/billing?checkout=cancel"),
        client_reference: format!("{}:{}:{}", owner.kind(), owner_id(owner), plan_id),
        autopay: data.autopay.unwrap_or(true),
    };

    match provider::create_checkout_session(&params).await {
        Ok(session) => {
            crate::audit::record_action(
                pool.get_ref(),
                &req,
                crate::audit::AuditEvent {
                    actor_user_id: user_id,
                    action: "checkout_started",
                    resource_type: "plan",
                    resource_id: Some(data.plan_code.trim().to_string()),
                    metadata: None,
                },
            )
            .await;
            Ok(HttpResponse::Ok()
                .json(serde_json::json!({ "url": session.url, "session_id": session.id })))
        }
        Err(e) => {
            error!(target: "billing", error = ?e, "checkout session create failed");
            Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not start checkout" })))
        }
    }
}

/// In-page subscription creation. Returns a PaymentIntent client_secret
/// the frontend uses to mount a Payment Element and confirm the charge
/// without ever redirecting to checkout.stripe.com. The subscription is
/// created in `incomplete` state; the webhook handler flips it to
/// `active` after the confirm round-trip succeeds.
#[post("/billing/subscriptions")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_inline_subscription(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CheckoutInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    // Same plan/price/audience validation as the hosted-checkout path.
    let plan = sqlx::query_as::<_, (i32, Option<String>, String)>(
        "SELECT id, stripe_price_id, audience FROM plans WHERE code = $1 AND is_active = true",
    )
    .bind(data.plan_code.trim())
    .fetch_optional(pool.get_ref())
    .await?;

    let (plan_id, price_id, audience) = match plan {
        Some(row) => row,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Unknown plan" }))
            );
        }
    };

    if audience != owner.kind() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": format!("This plan is for {audience} accounts")
        })));
    }
    let Some(price_id) = price_id.filter(|p| !p.is_empty()) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "This plan is not linked to a Stripe price yet"
        })));
    };

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return Ok(resp),
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let client_reference = format!("{}:{}:{}", owner.kind(), owner_id(owner), plan_id);

    match provider::create_subscription(&customer_id, &price_id, &client_reference).await {
        Ok(pending) => Ok(HttpResponse::Ok().json(serde_json::json!({
            "subscription_id": pending.subscription_id,
            "client_secret": pending.client_secret,
            "publishable_key": provider::publishable_key(),
        }))),
        Err(e) => {
            error!(target: "billing", error = ?e, "inline subscription create failed");
            Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not start subscription" })))
        }
    }
}

#[instrument(target = "http", skip(req))]
pub async fn stripe_status(req: HttpRequest) -> AppResult {
    if let Err(resp) = super::current_user(&req) {
        return Ok(resp);
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "configured": provider::is_configured(),
        "test_mode": provider::is_test_mode(),
        "country": "US",
        "publishable_key": provider::publishable_key().unwrap_or_else(|| "pk_test_sample_configure_in_env".to_string())
    })))
}

#[post("/billing/portal")]
#[instrument(target = "http", skip(req, pool))]
pub async fn create_portal(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return Ok(resp),
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    match provider::create_portal_session(&customer_id, &format!("{}/billing", frontend_url()))
        .await
    {
        Ok(url) => Ok(HttpResponse::Ok().json(serde_json::json!({ "url": url }))),
        Err(e) => {
            error!(target: "billing", error = ?e, "portal session create failed");
            Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not open the billing portal" })))
        }
    }
}

#[post("/billing/payment-method/setup-intent")]
#[instrument(target = "http", skip(req, pool))]
pub async fn create_payment_method_setup_intent(
    req: HttpRequest,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return Ok(resp),
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    match provider::create_setup_intent(&customer_id).await {
        Ok(intent) => {
            Ok(HttpResponse::Ok()
                .json(serde_json::json!({ "client_secret": intent.client_secret })))
        }
        Err(e) => {
            error!(target: "billing", error = ?e, "setup intent create failed");
            Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not prepare payment method entry" })))
        }
    }
}

#[post("/billing/payment-method/default")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn set_default_payment_method(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<DefaultPaymentMethodInput>,
) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    let payment_method_id = data.payment_method_id.trim();
    if !payment_method_id.starts_with("pm_") {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Invalid payment method" })));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return Ok(resp);
    }

    let customer_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT stripe_customer_id FROM billing_customers
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(customer_id) = customer_id else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "No billing customer found" })));
    };

    if let Err(e) =
        provider::set_customer_default_payment_method(&customer_id, payment_method_id).await
    {
        error!(target: "billing", error = ?e, "customer default payment method update failed");
        return Ok(HttpResponse::BadGateway()
            .json(serde_json::json!({ "message": "Could not save payment method" })));
    }

    let subscription_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT stripe_subscription_id FROM subscriptions
         WHERE (($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2))
           AND stripe_subscription_id IS NOT NULL
           AND status IN ('active', 'trialing', 'past_due', 'incomplete')
         ORDER BY updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(subscription_id) = subscription_id.filter(|id| !id.is_empty())
        && let Err(e) =
            provider::set_subscription_default_payment_method(&subscription_id, payment_method_id)
                .await
    {
        error!(target: "billing", error = ?e, "subscription payment method update failed");
        return Ok(HttpResponse::BadGateway().json(
            serde_json::json!({ "message": "Could not update subscription payment method" }),
        ));
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "payment_method_set",
            resource_type: "payment_method",
            resource_id: Some(payment_method_id.to_string()),
            metadata: None,
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "saved": true })))
}
