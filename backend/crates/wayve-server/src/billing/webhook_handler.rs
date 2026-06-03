// Stripe webhook receiver. Mounted as a PUBLIC route (no JWT) — it
// authenticates by verifying the Stripe signature over the raw body, then
// dedupes on the Stripe event id. Processing is idempotent (upserts), so the
// dedup row is only written after a successful run: a transient failure
// returns 500 and Stripe safely retries.

use super::entitlements::refresh_entitlements;
use super::models::BillingOwner;
use crate::email::profile::invalidate_me_cache;
use crate::routes::user::invalidate_profile_cache;

/// A plan/limit/status just changed for `owner`; drop the per-user caches that
/// embed plan info (`/api/me`, `/api/profile`) so the next request returns the
/// new plan + storage limit instead of a stale (30–60s) cached copy. For an
/// organization every member's view changes, so invalidate all of them.
async fn invalidate_owner_caches(pool: &PgPool, owner: BillingOwner) {
    match owner {
        BillingOwner::User(uid) => {
            invalidate_me_cache(uid).await;
            invalidate_profile_cache(uid).await;
        }
        BillingOwner::Organization(org_id) => {
            let members = sqlx::query_scalar::<_, i32>(
                "SELECT id FROM users WHERE organization_id = $1",
            )
            .bind(org_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            for uid in members {
                invalidate_me_cache(uid).await;
                invalidate_profile_cache(uid).await;
            }
        }
    }
}
use super::provider;
use crate::prelude::*;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, instrument, warn};

// Append-only JSON-lines audit trail of billing events (subscription /
// upgrade / payment), written under the project `logs/` directory next to
// `access_requests.log`. Best-effort: a logging failure must never break
// webhook processing (Stripe would otherwise retry a state change that
// already landed in the DB).
const BILLING_LOG_DIR: &str = "logs";
const BILLING_LOG_PATH: &str = "logs/billing_events.log";

async fn append_billing_event(event: serde_json::Value) {
    let line = match serde_json::to_string(&event) {
        Ok(s) => s,
        Err(err) => {
            warn!(target: "billing", error = ?err, "billing event log serialize failed");
            return;
        }
    };
    let _ = tokio::fs::create_dir_all(BILLING_LOG_DIR).await;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(BILLING_LOG_PATH)
        .await
    {
        Ok(mut file) => {
            if let Err(err) = file.write_all(format!("{line}\n").as_bytes()).await {
                warn!(target: "billing", error = ?err, "billing event log write failed");
            }
        }
        Err(err) => warn!(target: "billing", error = ?err, "billing event log open failed"),
    }
}

#[post("/billing/webhook")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn stripe_webhook(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Bytes,
) -> AppResult {
    let Some(secret) = provider::webhook_secret() else {
        warn!(target: "billing", "webhook received but STRIPE_WEBHOOK_SECRET unset; ignoring");
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "ignored": true })));
    };

    let signature = match req
        .headers()
        .get("Stripe-Signature")
        .and_then(|value| value.to_str().ok())
    {
        Some(sig) => sig,
        None => return Ok(HttpResponse::BadRequest().body("missing signature")),
    };
    if !provider::verify_webhook_signature(&body, signature, &secret) {
        warn!(target: "billing", "webhook signature verification failed");
        return Ok(HttpResponse::BadRequest().body("bad signature"));
    }

    let event: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return Ok(HttpResponse::BadRequest().body("invalid json")),
    };
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or("");
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    if event_id.is_empty() {
        return Ok(HttpResponse::BadRequest().body("missing event id"));
    }

    // Idempotency: a previously processed event is acknowledged, not re-run.
    let already_processed =
        sqlx::query_scalar::<_, i32>("SELECT 1 FROM webhook_events WHERE stripe_event_id = $1")
            .bind(event_id)
            .fetch_optional(pool.get_ref())
            .await?
            .is_some();
    if already_processed {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "duplicate": true })));
    }

    let object = event
        .get("data")
        .and_then(|data| data.get("object"))
        .cloned()
        .unwrap_or(Value::Null);

    let result = match event_type {
        "checkout.session.completed" => handle_checkout_completed(pool.get_ref(), &object).await,
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted" => {
            handle_subscription_event(pool.get_ref(), event_type, &object).await
        }
        "invoice.created" | "invoice.finalized" | "invoice.paid" | "invoice.payment_succeeded" => {
            handle_invoice_event(pool.get_ref(), &object).await
        }
        other => {
            info!(target: "billing", event = other, "unhandled webhook event");
            Ok(())
        }
    };

    // A transient processing failure returns 500 on purpose so Stripe retries.
    if let Err(e) = result {
        error!(target: "billing", event_type, error = ?e, "webhook processing failed");
        return Ok(HttpResponse::InternalServerError().finish());
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO webhook_events (stripe_event_id, event_type) VALUES ($1, $2)
         ON CONFLICT (stripe_event_id) DO NOTHING",
    )
    .bind(event_id)
    .bind(event_type)
    .execute(pool.get_ref())
    .await
    {
        error!(target: "billing", error = ?e, "webhook dedup insert failed");
    }

    info!(target: "billing", event_type, "webhook processed");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "received": true })))
}

/// Parse a checkout `client_reference_id` of the form `kind:owner_id:plan_id`.
fn parse_reference(reference: &str) -> Option<(BillingOwner, Option<i32>)> {
    let mut parts = reference.split(':');
    let kind = parts.next()?;
    let owner_id: i32 = parts.next()?.parse().ok()?;
    let plan_id: Option<i32> = parts.next().and_then(|value| value.parse().ok());
    let owner = match kind {
        "personal" => BillingOwner::User(owner_id),
        "organization" => BillingOwner::Organization(owner_id),
        _ => return None,
    };
    Some((owner, plan_id))
}

async fn subscription_owner(pool: &PgPool, stripe_sub_id: &str) -> Result<Option<BillingOwner>> {
    let row = sqlx::query_as::<_, (Option<i32>, Option<i32>)>(
        "SELECT user_id, organization_id FROM subscriptions WHERE stripe_subscription_id = $1",
    )
    .bind(stripe_sub_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(user_id, org_id)| match (user_id, org_id) {
        (Some(id), _) => Some(BillingOwner::User(id)),
        (_, Some(id)) => Some(BillingOwner::Organization(id)),
        _ => None,
    }))
}

async fn handle_checkout_completed(pool: &PgPool, object: &Value) -> Result<()> {
    let reference = object
        .get("client_reference_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let customer = object.get("customer").and_then(Value::as_str);
    let subscription = object.get("subscription").and_then(Value::as_str);

    let (Some((owner, plan_id)), Some(sub_id)) = (parse_reference(reference), subscription) else {
        warn!(target: "billing", "checkout completed without a recognizable reference");
        return Ok(());
    };

    sqlx::query(
        r#"
        INSERT INTO subscriptions
            (user_id, organization_id, plan_id, stripe_subscription_id,
             stripe_customer_id, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET
            status = 'active',
            plan_id = EXCLUDED.plan_id,
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            updated_at = NOW()
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .bind(plan_id)
    .bind(sub_id)
    .bind(customer)
    .execute(pool)
    .await?;

    refresh_entitlements(pool, owner).await?;
    invalidate_owner_caches(pool, owner).await;

    append_billing_event(serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "event": "subscribed",
        "stripe_subscription_id": sub_id,
        "stripe_customer_id": customer,
        "user_id": owner.user_id(),
        "organization_id": owner.organization_id(),
        "plan_id": plan_id,
        "status": "active",
    }))
    .await;
    Ok(())
}

async fn handle_subscription_event(pool: &PgPool, event_type: &str, object: &Value) -> Result<()> {
    let sub_id = object.get("id").and_then(Value::as_str).unwrap_or("");
    if sub_id.is_empty() {
        return Ok(());
    }
    let status = if event_type == "customer.subscription.deleted" {
        "canceled".to_string()
    } else {
        object
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            .to_string()
    };
    let period_end = object.get("current_period_end").and_then(Value::as_i64);
    let cancel = object
        .get("cancel_at_period_end")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let updated = sqlx::query(
        r#"
        UPDATE subscriptions
           SET status = $2,
               current_period_end = CASE
                   WHEN $3::bigint IS NULL THEN current_period_end
                   ELSE to_timestamp($3::double precision)
               END,
               cancel_at_period_end = $4,
               updated_at = NOW()
         WHERE stripe_subscription_id = $1
        "#,
    )
    .bind(sub_id)
    .bind(&status)
    .bind(period_end)
    .bind(cancel)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        return Ok(());
    }
    if let Some(owner) = subscription_owner(pool, sub_id).await? {
        refresh_entitlements(pool, owner).await?;
        invalidate_owner_caches(pool, owner).await;
        append_billing_event(serde_json::json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "upgraded",
            "stripe_subscription_id": sub_id,
            "user_id": owner.user_id(),
            "organization_id": owner.organization_id(),
            "status": status,
        }))
        .await;
    }
    Ok(())
}

async fn handle_invoice_event(pool: &PgPool, object: &Value) -> Result<()> {
    let invoice_id = object.get("id").and_then(Value::as_str).unwrap_or("");
    if invoice_id.is_empty() {
        return Ok(());
    }
    let customer = object.get("customer").and_then(Value::as_str);
    let amount_due = object
        .get("amount_due")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let amount_paid = object
        .get("amount_paid")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let currency = object
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("usd");
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("draft");
    let hosted = object.get("hosted_invoice_url").and_then(Value::as_str);
    let pdf = object.get("invoice_pdf").and_then(Value::as_str);
    let period_start = object.get("period_start").and_then(Value::as_i64);
    let period_end = object.get("period_end").and_then(Value::as_i64);

    sqlx::query(
        r#"
        INSERT INTO invoices
            (stripe_invoice_id, stripe_customer_id, amount_due_cents,
             amount_paid_cents, currency, status, hosted_invoice_url, invoice_pdf,
             period_start, period_end)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9::double precision) END,
            CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10::double precision) END)
        ON CONFLICT (stripe_invoice_id) DO UPDATE SET
            amount_due_cents = EXCLUDED.amount_due_cents,
            amount_paid_cents = EXCLUDED.amount_paid_cents,
            status = EXCLUDED.status,
            hosted_invoice_url = EXCLUDED.hosted_invoice_url,
            invoice_pdf = EXCLUDED.invoice_pdf
        "#,
    )
    .bind(invoice_id)
    .bind(customer)
    .bind(amount_due)
    .bind(amount_paid)
    .bind(currency)
    .bind(status)
    .bind(hosted)
    .bind(pdf)
    .bind(period_start)
    .bind(period_end)
    .execute(pool)
    .await?;

    append_billing_event(serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "event": "payment",
        "stripe_invoice_id": invoice_id,
        "stripe_customer_id": customer,
        "amount_paid_cents": amount_paid,
        "amount_due_cents": amount_due,
        "currency": currency,
        "status": status,
    }))
    .await;
    Ok(())
}
