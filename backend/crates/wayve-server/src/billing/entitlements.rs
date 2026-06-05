// Effective entitlements for a billing owner. The `entitlements` table is a
// materialized snapshot of "what does this owner's active plan grant",
// refreshed whenever a subscription changes (checkout completion / webhook).
// Feature modules enforce limits by calling the helpers here.

use super::models::{BillingOwner, Entitlement};
use super::resolve_owner;
use crate::prelude::*;
use tracing::{error, instrument};

/// Storage granted to an owner with no paid subscription (free baseline).
const FREE_STORAGE_BYTES: i64 = 1_073_741_824; // 1 GiB

fn free_defaults() -> Entitlement {
    Entitlement {
        plan_code: Some("basic_user".to_string()),
        storage_limit_bytes: FREE_STORAGE_BYTES,
        seat_limit: 1,
        features: serde_json::json!({
            "emails_per_day": 1000,
            "send_receive_per_day": 1000,
            "autopay": false
        }),
        active: false,
    }
}

/// Resolve the owner's effective entitlements, falling back to the free
/// baseline when no snapshot exists yet.
pub async fn effective_entitlements(pool: &PgPool, owner: BillingOwner) -> Entitlement {
    let row = sqlx::query_as::<_, Entitlement>(
        r#"
        SELECT plan_code, storage_limit_bytes, seat_limit, features, active
          FROM entitlements
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool)
    .await;

    match row {
        Ok(Some(entitlement)) => entitlement,
        Ok(None) => free_defaults(),
        Err(e) => {
            error!(target: "billing", error = ?e, "entitlement lookup failed");
            free_defaults()
        }
    }
}

/// Recompute and persist the owner's entitlement snapshot from their current
/// active subscription. Called after checkout completion and from webhooks.
pub async fn refresh_entitlements(pool: &PgPool, owner: BillingOwner) -> Result<()> {
    let plan = sqlx::query_as::<_, (String, i64, i32, Value)>(
        r#"
        SELECT p.code, p.storage_limit_bytes, p.seat_limit, p.features
          FROM subscriptions s
          JOIN plans p ON p.id = s.plan_id
         WHERE s.status IN ('active', 'trialing')
           AND ($1::int IS NULL OR s.user_id = $1)
           AND ($2::int IS NULL OR s.organization_id = $2)
         ORDER BY s.updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool)
    .await?;

    let (plan_code, storage, seats, features, active) = match plan {
        Some((code, storage, seats, features)) => (Some(code), storage, seats, features, true),
        None => (None, FREE_STORAGE_BYTES, 1, serde_json::json!({}), false),
    };

    // Prior snapshot — so the audit row below fires only on a real grant
    // change (plan or active flip), not on every renewal webhook.
    let prior = sqlx::query_as::<_, (Option<String>, bool)>(
        r#"
        SELECT plan_code, active FROM entitlements
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
         LIMIT 1
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .fetch_optional(pool)
    .await?;

    let updated = sqlx::query(
        r#"
        UPDATE entitlements
           SET plan_code = $3, storage_limit_bytes = $4, seat_limit = $5,
               features = $6, active = $7, updated_at = NOW()
         WHERE ($1::int IS NOT NULL AND user_id = $1)
            OR ($2::int IS NOT NULL AND organization_id = $2)
        "#,
    )
    .bind(owner.user_id())
    .bind(owner.organization_id())
    .bind(plan_code.as_deref())
    .bind(storage)
    .bind(seats)
    .bind(&features)
    .bind(active)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        sqlx::query(
            r#"
            INSERT INTO entitlements
                (user_id, organization_id, plan_code, storage_limit_bytes,
                 seat_limit, features, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(owner.user_id())
        .bind(owner.organization_id())
        .bind(plan_code.as_deref())
        .bind(storage)
        .bind(seats)
        .bind(&features)
        .bind(active)
        .execute(pool)
        .await?;
    }

    // Audit the grant only when it materially changed. A grant (active true) or
    // revoke (active false) is a financial signal worth a permanent row.
    let (prior_plan, prior_active) = prior.unwrap_or((None, false));
    if prior_plan != plan_code || prior_active != active {
        crate::audit::record_billing(
            pool,
            crate::audit::BillingAuditEvent {
                actor_user_id: owner.user_id(),
                organization_id: owner.organization_id(),
                action: if active {
                    "entitlement_grant"
                } else {
                    "entitlement_revoke"
                },
                resource_type: "entitlement",
                resource_id: plan_code.clone(),
                metadata: Some(serde_json::json!({
                    "plan_code": plan_code,
                    "previous_plan_code": prior_plan,
                    "storage_limit_bytes": storage,
                    "seat_limit": seats,
                    "active": active,
                })),
            },
        )
        .await;
    }

    Ok(())
}

// Enforcement seam: other feature modules (drive uploads, email send caps,
// ...) call `effective_entitlements` and compare against the relevant limit
// before allowing a billable action.

#[get("/billing/entitlements")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_entitlements(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };
    let owner = match resolve_owner(pool.get_ref(), user_id).await {
        Ok(owner) => owner,
        Err(resp) => return Ok(resp),
    };

    let entitlement = effective_entitlements(pool.get_ref(), owner).await;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "owner_type": owner.kind(),
        "plan_code": entitlement.plan_code,
        "storage_limit_bytes": entitlement.storage_limit_bytes,
        "seat_limit": entitlement.seat_limit,
        "features": entitlement.features,
        "active": entitlement.active,
    })))
}
