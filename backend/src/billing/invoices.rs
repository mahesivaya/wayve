// Invoice history. Rows are a projection of Stripe invoices populated by the
// webhook handler; each carries the Stripe-hosted invoice + PDF URLs.

use super::models::Invoice;
use super::resolve_owner;
use crate::prelude::*;
use tracing::instrument;

#[get("/billing/invoices")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_invoices(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };

    let invoices = sqlx::query_as::<_, Invoice>(
        r#"
        SELECT i.id, i.stripe_invoice_id, i.amount_due_cents, i.amount_paid_cents,
               i.currency, i.status, i.hosted_invoice_url, i.invoice_pdf, i.created_at
          FROM invoices i
          JOIN billing_customers bc ON bc.stripe_customer_id = i.stripe_customer_id
         WHERE ($1::int IS NOT NULL AND bc.user_id = $1)
            OR ($2::int IS NOT NULL AND bc.organization_id = $2)
         ORDER BY i.created_at DESC
         LIMIT 100
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(invoices))
}
