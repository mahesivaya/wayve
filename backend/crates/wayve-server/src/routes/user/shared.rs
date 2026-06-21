//! Role/access helpers shared across the `user` route submodules.
//!
//! These are also consumed by other feature modules (email/profile, billing),
//! so they are re-exported from `routes::user` via `pub use shared::*`.

use crate::cache::TtlCache;
use crate::prelude::*;
use wayve_security::rbac::{self, Role, Scope};

const PROFILE_CACHE_TTL_SECS: u64 = 30;
const PROFILE_CACHE_MAX_CAPACITY: u64 = 5000;

pub(super) static PROFILE_CACHE: Lazy<TtlCache<i32, serde_json::Value>> =
    Lazy::new(|| TtlCache::new(PROFILE_CACHE_MAX_CAPACITY, PROFILE_CACHE_TTL_SECS));

pub async fn invalidate_profile_cache(user_id: i32) {
    PROFILE_CACHE.invalidate(&user_id).await;
}

/// Canonical account-type string. `account_type` is a plain TEXT column;
/// anything unrecognized normalizes to "personal".
pub fn normalized_account_type(value: &str) -> &str {
    match value {
        "organization" | "organization_admin" | "platform_admin" => value,
        _ => "personal",
    }
}

/// Organization name as shown to the current user.
///
/// Personal accounts do not belong to an organization, but the UI displays the
/// email address in that slot so account headers stay consistent.
pub fn display_organization_name(
    account_type: &str,
    email: &str,
    organization_name: Option<String>,
) -> Option<String> {
    if normalized_account_type(account_type) == "personal" {
        Some(email.to_string())
    } else {
        organization_name
    }
}

pub fn normalized_org_role(value: &str) -> &str {
    match value {
        "owner" | "super_admin" | "admin" | "security" | "billing" | "developer" | "support"
        | "member" | "guest" => value,
        _ => "member",
    }
}

pub fn normalized_platform_role(value: &str) -> &str {
    match value {
        "owner" | "super_admin" | "admin" | "security" | "billing" | "developer" | "support"
        | "member" | "guest" => value,
        _ => "member",
    }
}

pub(super) fn default_role_for_account_type(account_type: &str) -> &'static str {
    match normalized_account_type(account_type) {
        "organization_admin" => "owner",
        "organization" => "member",
        "platform_admin" => "owner",
        _ => "owner",
    }
}

pub(super) fn role_label(role: &str, account_type: &str) -> &'static str {
    match normalized_account_type(account_type) {
        "personal" => "Personal workspace owner",
        "platform_admin" => match normalized_platform_role(role) {
            "owner" => "Platform owner",
            "super_admin" => "Platform super admin",
            "admin" => "Platform admin",
            "security" => "Platform security",
            "billing" => "Platform billing",
            "developer" => "Platform developer",
            "support" => "Platform support",
            "guest" => "Platform guest",
            _ => "Platform member",
        },
        _ => match normalized_org_role(role) {
            "owner" => "Organization owner",
            "super_admin" => "Organization super admin",
            "admin" => "Organization admin",
            "security" => "Organization security",
            "billing" => "Organization billing",
            "developer" => "Developer",
            "support" => "Support",
            "guest" => "Guest",
            _ => "Member",
        },
    }
}

/// Resolve a user's effective role string and its display label.
///
/// Delegates to `rbac::resolve_role_context` so role resolution lives in one
/// place; this wrapper only adds the scope-prefixed human label.
pub async fn effective_role_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<(String, String), sqlx::Error> {
    let ctx = rbac::resolve_role_context(pool, user_id).await?;
    Ok((
        ctx.role.as_str().to_string(),
        effective_role_label(ctx.scope, ctx.role),
    ))
}

/// Scope-prefixed display label for a resolved role.
fn effective_role_label(scope: Scope, role: Role) -> String {
    match scope {
        Scope::Personal => "Personal workspace owner".to_string(),
        Scope::Platform => format!("Platform {}", role.label().to_lowercase()),
        Scope::Organization => match role {
            Role::Owner => "Organization owner".to_string(),
            Role::SuperAdmin => "Organization super admin".to_string(),
            Role::Admin => "Organization admin".to_string(),
            Role::Security => "Organization security".to_string(),
            Role::Billing => "Organization billing".to_string(),
            Role::Developer => "Developer".to_string(),
            Role::Support => "Support".to_string(),
            Role::Member => "Member".to_string(),
            Role::Guest => "Guest".to_string(),
        },
    }
}

/// A user's resolved access — role, scope, and the permission strings the
/// frontend uses to gate UI. Returned by `/api/me` and `/profile`.
pub struct EffectiveAccess {
    pub role: String,
    pub role_label: String,
    pub scope: String,
    pub permissions: Vec<String>,
}

/// A snapshot of the user's current plan, suitable for embedding in the
/// `/api/me` / `/api/profile` response. The frontend uses `code` + `name`
/// to render the tier badge and decide whether to show the "Upgrade" CTA.
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct CurrentPlan {
    pub code: String,
    pub name: String,
    pub audience: String,
    /// Sub-tier within the audience: `personal`, `startups`, `business`, or
    /// `enterprise` (mirrors `plans.tier`). The synthetic "not subscribed" org
    /// row carries `none`. Lets the UI distinguish Business from Enterprise.
    pub tier: String,
    pub amount_cents: i64,
}

/// Resolve the user's current tier.
///
/// Strategy:
///   1. If the user belongs to an organization → the org's active
///      subscription plan (org members inherit it). A leftover *personal*
///      subscription is ignored so it can't shadow the org plan. With no org
///      subscription, a synthetic `organization_free` row (so org headers
///      don't mislabel as the personal "Basic User" tier).
///   2. Otherwise (personal account) → the user's own active subscription,
///      else the canonical `basic_user` free tier.
pub async fn current_plan_for_user(
    pool: &PgPool,
    user_id: i32,
    organization_id: Option<i32>,
) -> Result<CurrentPlan, sqlx::Error> {
    // Organization accounts resolve to the ORG's plan first. A user who later
    // becomes an org owner/member may still carry a leftover *personal*
    // subscription from before; that must not shadow the org plan (it would
    // read as "Organization account · Current plan: Advance"). So when the
    // user belongs to an org, the org subscription is authoritative.
    if let Some(org_id) = organization_id {
        if let Some(plan) = sqlx::query_as::<_, CurrentPlan>(
            r#"
            SELECT p.code, p.name, p.audience, p.tier, p.amount_cents
              FROM subscriptions s
              JOIN plans p ON p.id = s.plan_id
             WHERE s.status = 'active'
               AND s.organization_id = $1
             ORDER BY s.id DESC
             LIMIT 1
            "#,
        )
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        {
            return Ok(plan);
        }

        // Org with no active subscription. Synthesize an org-audience
        // "free" row instead of leaking the personal basic_user name into
        // org headers (which read as a contradiction in the UI).
        return Ok(CurrentPlan {
            code: "organization_free".to_string(),
            name: "Not subscribed".to_string(),
            audience: "organization".to_string(),
            tier: "none".to_string(),
            amount_cents: 0,
        });
    }

    // Personal accounts: their own active subscription, else the free tier.
    if let Some(plan) = sqlx::query_as::<_, CurrentPlan>(
        r#"
        SELECT p.code, p.name, p.audience, p.tier, p.amount_cents
          FROM subscriptions s
          JOIN plans p ON p.id = s.plan_id
         WHERE s.status = 'active'
           AND s.user_id = $1
         ORDER BY s.id DESC
         LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(plan);
    }

    sqlx::query_as::<_, CurrentPlan>(
        "SELECT code, name, audience, tier, amount_cents FROM plans WHERE code = 'basic_user'",
    )
    .fetch_one(pool)
    .await
}

/// Full access info for a user, computed from the RBAC role context.
pub async fn effective_access_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<EffectiveAccess, sqlx::Error> {
    let ctx = rbac::resolve_role_context(pool, user_id).await?;
    Ok(EffectiveAccess {
        role: ctx.role.as_str().to_string(),
        role_label: effective_role_label(ctx.scope, ctx.role),
        scope: ctx.scope.as_str().to_string(),
        permissions: ctx.permission_strings(),
    })
}

/// Best-effort access used only when the role-context query fails (a DB error).
/// Derives scope/role from the account_type the caller already holds.
pub fn fallback_access(account_type: &str) -> EffectiveAccess {
    let (scope, role) = match normalized_account_type(account_type) {
        "platform_admin" => (Scope::Platform, Role::Owner),
        "organization_admin" => (Scope::Organization, Role::Owner),
        "organization" => (Scope::Organization, Role::Member),
        _ => (Scope::Personal, Role::Owner),
    };
    EffectiveAccess {
        role: role.as_str().to_string(),
        role_label: effective_role_label(scope, role),
        scope: scope.as_str().to_string(),
        permissions: rbac::permissions_for(role)
            .iter()
            .map(|perm| perm.as_str().to_string())
            .collect(),
    }
}
