// Organization-scoped billing overview: seat usage vs the plan's seat limit,
// the org subscription summary, and the member roster. Any member of the org
// may read it; mutations go through the shared owner-manager guard.

use super::entitlements::effective_entitlements;
use super::models::BillingOwner;
use crate::prelude::*;
use crate::routes::user::{
    effective_role_for_user, normalized_account_type, normalized_platform_role,
};
use chrono::{DateTime, Utc};
use tracing::{error, instrument};

#[get("/billing/organization")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_organization_billing(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let user_id = match super::current_user(&req) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let (account_type, organization_id) = match super::account_row(pool.get_ref(), user_id).await {
        Ok(row) => row,
        Err(resp) => return resp,
    };

    let Some(org_id) = organization_id else {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "You are not part of an organization" }));
    };
    let owner = BillingOwner::Organization(org_id);

    let org = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT name, slug FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await;
    let (org_name, org_slug) = match org {
        Ok(Some(row)) => row,
        Ok(None) => return HttpResponse::NotFound().finish(),
        Err(e) => {
            error!(target: "billing", error = ?e, "organization lookup failed");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let seats_used = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)::BIGINT FROM users WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(pool.get_ref())
    .await
    .unwrap_or(0);

    let entitlement = effective_entitlements(pool.get_ref(), owner).await;

    let subscription = sqlx::query(
        r#"
        SELECT s.status, s.current_period_end, s.cancel_at_period_end, p.code AS plan_code
          FROM subscriptions s
          LEFT JOIN plans p ON p.id = s.plan_id
         WHERE s.organization_id = $1
         ORDER BY s.updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await;

    let subscription_json = match subscription {
        Ok(Some(row)) => {
            let period_end: Option<DateTime<Utc>> =
                row.try_get("current_period_end").ok().flatten();
            serde_json::json!({
                "status": row.get::<String, _>("status"),
                "current_period_end": period_end,
                "cancel_at_period_end": row.get::<bool, _>("cancel_at_period_end"),
                "plan_code": row.try_get::<Option<String>, _>("plan_code").ok().flatten(),
            })
        }
        Ok(None) => Value::Null,
        Err(e) => {
            error!(target: "billing", error = ?e, "org subscription lookup failed");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let members = sqlx::query(
        r#"
        SELECT u.id, u.email, u.account_type, COALESCE(om.role, 'member') AS role
        FROM users u
        LEFT JOIN organization_members om
          ON om.organization_id = u.organization_id AND om.user_id = u.id
        WHERE u.organization_id = $1
        ORDER BY u.id
        LIMIT 100
        "#,
    )
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|row| {
                serde_json::json!({
                    "id": row.get::<i32, _>("id"),
                    "email": row.get::<String, _>("email"),
                    "account_type": row.get::<String, _>("account_type"),
                    "role": row.get::<String, _>("role"),
                })
            })
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();

    let can_manage = match effective_role_for_user(pool.get_ref(), user_id).await {
        Ok((role, _)) => {
            if normalized_account_type(&account_type) == "platform_admin" {
                matches!(normalized_platform_role(&role), "owner" | "admin")
            } else {
                matches!(role.as_str(), "owner" | "admin")
            }
        }
        Err(e) => {
            error!(target: "billing", user_id, error = ?e, "role lookup failed");
            false
        }
    };

    HttpResponse::Ok().json(serde_json::json!({
        "organization": { "id": org_id, "name": org_name, "slug": org_slug },
        "can_manage": can_manage,
        "seats_used": seats_used,
        "seat_limit": entitlement.seat_limit,
        "storage_limit_bytes": entitlement.storage_limit_bytes,
        "plan_code": entitlement.plan_code,
        "plan_active": entitlement.active,
        "subscription": subscription_json,
        "members": members,
    }))
}
