//! Role/access helpers shared across the `user` route submodules.
//!
//! These are also consumed by other feature modules (email/profile, billing),
//! so they are re-exported from `routes::user` via `pub use shared::*`.

use crate::cache::TtlCache;
use crate::prelude::*;
use wayve_security::rbac::{self, Role, Scope};

const PROFILE_CACHE_TTL_SECS: u64 = 30;
const PROFILE_CACHE_MAX_CAPACITY: u64 = 5000;

// Keyed by (user_id, mode) — see the /me cache note; the profile body is
// likewise mode-dependent.
pub(super) static PROFILE_CACHE: Lazy<
    TtlCache<(i32, wayve_security::jwt::SessionMode), serde_json::Value>,
> = Lazy::new(|| TtlCache::new(PROFILE_CACHE_MAX_CAPACITY, PROFILE_CACHE_TTL_SECS));

pub async fn invalidate_profile_cache(user_id: i32) {
    PROFILE_CACHE
        .invalidate(&(user_id, wayve_security::jwt::SessionMode::Normal))
        .await;
    PROFILE_CACHE
        .invalidate(&(user_id, wayve_security::jwt::SessionMode::Admin))
        .await;
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

/// Resolve a user's effective role string and its display label, downscoped by
/// the request's session mode — so a normal-mode owner resolves as a `member`.
/// Used by admin billing gates so they refuse a normal-mode owner.
pub async fn effective_role_for_request(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<(String, String), sqlx::Error> {
    let ctx = rbac::resolve_role_context_moded(req, pool, user_id).await?;
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
    /// True only for THE first owner of an organization OR the platform — the
    /// earliest-joined `owner` row (tie-break lowest user_id) in
    /// `organization_members` / `platform_members`. Used to gate owner-only,
    /// single-person affordances (e.g. connecting the scope's own OAuth mailbox)
    /// to one person, not every user who holds the `owner` role. Always false
    /// for personal scope.
    pub is_primary_owner: bool,
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

/// True only for THE first owner of a privileged scope: the earliest-joined
/// `owner` membership row (tie-break by lowest user_id) in the organization
/// (`organization_members`) or the platform (`platform_members`). Lets us
/// restrict an owner-only affordance to a single person rather than everyone
/// holding the `owner` role. Personal scope is never a primary owner.
async fn is_primary_scope_owner(
    pool: &PgPool,
    ctx: &rbac::RoleContext,
) -> Result<bool, sqlx::Error> {
    if !matches!(ctx.role, Role::Owner) {
        return Ok(false);
    }
    let first_owner: Option<i32> = match ctx.scope {
        Scope::Organization => {
            let Some(org_id) = ctx.organization_id else {
                return Ok(false);
            };
            sqlx::query_scalar(
                "SELECT user_id FROM organization_members \
                 WHERE organization_id = $1 AND role = 'owner' \
                 ORDER BY created_at ASC, user_id ASC \
                 LIMIT 1",
            )
            .bind(org_id)
            .fetch_optional(pool)
            .await?
        }
        Scope::Platform => {
            sqlx::query_scalar(
                "SELECT user_id FROM platform_members \
                 WHERE role = 'owner' \
                 ORDER BY created_at ASC, user_id ASC \
                 LIMIT 1",
            )
            .fetch_optional(pool)
            .await?
        }
        Scope::Personal => return Ok(false),
    };
    Ok(first_owner == Some(ctx.user_id))
}

/// Request-aware access: the DB-truth role/scope downscoped by the request's
/// session mode. Returns the effective access (what the frontend gates on),
/// whether the caller is eligible to enter admin mode (computed from the TRUE
/// role, so the switcher shows even while downscoped), and the current mode.
/// `/me` and `/profile` use this so a normal-mode owner is reported restricted.
pub async fn effective_access_for_request(
    req: &HttpRequest,
    pool: &PgPool,
    user_id: i32,
) -> Result<(EffectiveAccess, bool, wayve_security::jwt::SessionMode), sqlx::Error> {
    let true_ctx = rbac::resolve_role_context(pool, user_id).await?;
    let can_switch_admin = rbac::can_enter_admin(&true_ctx);
    let mode = wayve_security::jwt::mode_from_request(req);
    let ctx = rbac::downscope_for_mode(true_ctx, mode);
    let is_primary_owner = is_primary_scope_owner(pool, &ctx).await?;
    Ok((
        EffectiveAccess {
            role: ctx.role.as_str().to_string(),
            role_label: effective_role_label(ctx.scope, ctx.role),
            scope: ctx.scope.as_str().to_string(),
            permissions: ctx.permission_strings(),
            is_primary_owner,
        },
        can_switch_admin,
        mode,
    ))
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
        // Fallback path can't confirm primary ownership (the DB lookup is what
        // just failed), so deny the owner-only affordance to be safe.
        is_primary_owner: false,
    }
}
