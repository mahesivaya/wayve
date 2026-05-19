// Checkout + Customer Portal. Subscriptions are created through Stripe's
// hosted Checkout; payment-method changes and invoice history are delegated
// to Stripe's hosted Customer Portal. Both endpoints return a URL for the
// frontend to redirect to.

use super::models::{BillingOwner, CheckoutInput};
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
) -> impl Responder {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !provider::is_configured() {
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" }));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return resp;
    }

    // Resolve the requested plan and confirm it is purchasable by this owner.
    let plan = sqlx::query_as::<_, (i32, Option<String>, String)>(
        "SELECT id, stripe_price_id, audience FROM plans WHERE code = $1 AND is_active = true",
    )
    .bind(data.plan_code.trim())
    .fetch_optional(pool.get_ref())
    .await;

    let (plan_id, price_id, audience) = match plan {
        Ok(Some(row)) => row,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({ "message": "Unknown plan" }));
        }
        Err(e) => {
            error!(target: "billing", error = ?e, "plan lookup failed");
            return HttpResponse::InternalServerError().finish();
        }
    };

    if audience != owner.kind() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": format!("This plan is for {audience} accounts")
        }));
    }
    let Some(price_id) = price_id.filter(|p| !p.is_empty()) else {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "message": "This plan is not linked to a Stripe price yet"
        }));
    };

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return resp,
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return resp,
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
        Ok(session) => HttpResponse::Ok()
            .json(serde_json::json!({ "url": session.url, "session_id": session.id })),
        Err(e) => {
            error!(target: "billing", error = ?e, "checkout session create failed");
            HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not start checkout" }))
        }
    }
}

#[get("/billing/stripe-status")]
#[instrument(target = "http", skip(req))]
pub async fn stripe_status(req: HttpRequest) -> impl Responder {
    if let Err(resp) = super::current_user(&req) {
        return resp;
    }

    HttpResponse::Ok().json(serde_json::json!({
        "configured": provider::is_configured(),
        "test_mode": provider::is_test_mode(),
        "country": "US",
        "publishable_key": provider::publishable_key().unwrap_or_else(|| "pk_test_sample_configure_in_env".to_string())
    }))
}

#[post("/billing/portal")]
#[instrument(target = "http", skip(req, pool))]
pub async fn create_portal(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !provider::is_configured() {
        return HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" }));
    }

    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return resp,
    };
    if let Err(resp) = require_owner_manager(pool.get_ref(), user_id, &owner).await {
        return resp;
    }

    let email = match actor_email(pool.get_ref(), user_id).await {
        Ok(email) => email,
        Err(resp) => return resp,
    };
    let customer_id = match ensure_customer(pool.get_ref(), owner, &email).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    match provider::create_portal_session(&customer_id, &format!("{}/billing", frontend_url()))
        .await
    {
        Ok(url) => HttpResponse::Ok().json(serde_json::json!({ "url": url })),
        Err(e) => {
            error!(target: "billing", error = ?e, "portal session create failed");
            HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not open the billing portal" }))
        }
    }
}
