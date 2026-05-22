//! Role-Based Access Control.
//!
//! A fixed permission catalog, a role→permission matrix for the nine roles, and
//! request-time authorization helpers. Roles live in two scopes —
//! `organization_members.role` and `platform_members.role`; a `personal`
//! account is implicitly the owner of a workspace of one.
//!
//! Authorization is computed per request straight from the database (see
//! `resolve_role_context`) and is **never** trusted from the JWT, so a role
//! change takes effect on the member's next request.

use crate::security::jwt::get_user_id_from_request;
use actix_web::{HttpRequest, HttpResponse};
use sqlx::{PgPool, Row};
use tracing::{error, warn};

use Permission::*;

/// Which membership table a user's role is drawn from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Personal,
    Organization,
    Platform,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Personal => "personal",
            Scope::Organization => "organization",
            Scope::Platform => "platform",
        }
    }
}

/// The nine roles, most-privileged first. `owner` implies the full permission
/// catalog; `super_admin` implies everything except the two billing
/// permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Owner,
    SuperAdmin,
    Admin,
    Security,
    Billing,
    Developer,
    Support,
    Member,
    Guest,
}

impl Role {
    pub const ALL: [Role; 9] = [
        Role::Owner,
        Role::SuperAdmin,
        Role::Admin,
        Role::Security,
        Role::Billing,
        Role::Developer,
        Role::Support,
        Role::Member,
        Role::Guest,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::SuperAdmin => "super_admin",
            Role::Admin => "admin",
            Role::Security => "security",
            Role::Billing => "billing",
            Role::Developer => "developer",
            Role::Support => "support",
            Role::Member => "member",
            Role::Guest => "guest",
        }
    }

    /// Parse a stored role string. An unrecognized value falls back to `Member`
    /// — the safe least-privilege default for an authenticated user.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Role {
        match value {
            "owner" => Role::Owner,
            "super_admin" => Role::SuperAdmin,
            "admin" => Role::Admin,
            "security" => Role::Security,
            "billing" => Role::Billing,
            "developer" => Role::Developer,
            "support" => Role::Support,
            "guest" => Role::Guest,
            _ => Role::Member,
        }
    }

    /// Bare human-readable label; call sites prefix it with the scope
    /// ("Platform owner", "Organization owner", ...).
    pub fn label(self) -> &'static str {
        match self {
            Role::Owner => "Owner",
            Role::SuperAdmin => "Super admin",
            Role::Admin => "Admin",
            Role::Security => "Security",
            Role::Billing => "Billing",
            Role::Developer => "Developer",
            Role::Support => "Support",
            Role::Member => "Member",
            Role::Guest => "Guest",
        }
    }

    /// Privilege rank — lower is more privileged.
    fn rank(self) -> u8 {
        match self {
            Role::Owner => 0,
            Role::SuperAdmin => 1,
            Role::Admin => 2,
            Role::Security | Role::Billing | Role::Developer | Role::Support => 3,
            Role::Member => 4,
            Role::Guest => 5,
        }
    }

    /// True when the role ranks strictly below `admin` — the set a
    /// `roles:assign_limited` holder is allowed to assign or modify.
    pub fn is_below_admin(self) -> bool {
        self.rank() > Role::Admin.rank()
    }
}

/// The permission catalog. Strings are `resource:action`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    AppsUse,
    AppsManage,
    ProfileManageSelf,
    MembersRead,
    MembersManage,
    RolesManage,
    RolesAssignLimited,
    OrgSettings,
    OrgDelete,
    BillingManage,
    BillingRead,
    UsageRead,
    ApiKeysManage,
    WebhooksManage,
    IntegrationsManage,
    LogsRead,
    LogsReadLimited,
    AuditRead,
    SecurityManage,
    TicketsManage,
    SsoManage,
    InboxManage,
}

impl Permission {
    pub const ALL: [Permission; 22] = [
        AppsUse,
        AppsManage,
        ProfileManageSelf,
        MembersRead,
        MembersManage,
        RolesManage,
        RolesAssignLimited,
        OrgSettings,
        OrgDelete,
        BillingManage,
        BillingRead,
        UsageRead,
        ApiKeysManage,
        WebhooksManage,
        IntegrationsManage,
        LogsRead,
        LogsReadLimited,
        AuditRead,
        SecurityManage,
        TicketsManage,
        SsoManage,
        InboxManage,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AppsUse => "apps:use",
            AppsManage => "apps:manage",
            ProfileManageSelf => "profile:manage_self",
            MembersRead => "members:read",
            MembersManage => "members:manage",
            RolesManage => "roles:manage",
            RolesAssignLimited => "roles:assign_limited",
            OrgSettings => "org:settings",
            OrgDelete => "org:delete",
            BillingManage => "billing:manage",
            BillingRead => "billing:read",
            UsageRead => "usage:read",
            ApiKeysManage => "api_keys:manage",
            WebhooksManage => "webhooks:manage",
            IntegrationsManage => "integrations:manage",
            LogsRead => "logs:read",
            LogsReadLimited => "logs:read_limited",
            AuditRead => "audit:read",
            SecurityManage => "security:manage",
            TicketsManage => "tickets:manage",
            SsoManage => "sso:manage",
            InboxManage => "inbox:manage",
        }
    }
}

// The role→permission matrix. `owner` is the whole catalog; every other role
// lists its grants explicitly (a `logs:read` holder also gets the limited form,
// so both are listed — there is no implication logic).
const P_SUPER_ADMIN: &[Permission] = &[
    AppsUse,
    AppsManage,
    ProfileManageSelf,
    MembersRead,
    MembersManage,
    RolesManage,
    RolesAssignLimited,
    OrgSettings,
    OrgDelete,
    UsageRead,
    ApiKeysManage,
    WebhooksManage,
    IntegrationsManage,
    LogsRead,
    LogsReadLimited,
    AuditRead,
    SecurityManage,
    TicketsManage,
    SsoManage,
    InboxManage,
];
const P_ADMIN: &[Permission] = &[
    AppsUse,
    AppsManage,
    ProfileManageSelf,
    MembersRead,
    MembersManage,
    RolesAssignLimited,
    OrgSettings,
    UsageRead,
    SsoManage,
    InboxManage,
];
const P_SECURITY: &[Permission] = &[
    AppsUse,
    ProfileManageSelf,
    MembersRead,
    LogsRead,
    LogsReadLimited,
    AuditRead,
    SecurityManage,
    SsoManage,
];
const P_BILLING: &[Permission] = &[
    AppsUse,
    ProfileManageSelf,
    MembersRead,
    BillingManage,
    BillingRead,
    UsageRead,
];
const P_DEVELOPER: &[Permission] = &[
    AppsUse,
    ProfileManageSelf,
    ApiKeysManage,
    WebhooksManage,
    IntegrationsManage,
    LogsRead,
    LogsReadLimited,
];
const P_SUPPORT: &[Permission] = &[
    AppsUse,
    ProfileManageSelf,
    MembersRead,
    UsageRead,
    LogsReadLimited,
    TicketsManage,
];
// `member` and `guest` share the baseline capability bundle; `guest`'s real
// limitation (visibility scoped to explicitly-shared resources) is a data-layer
// concern, not a permission.
const P_BASELINE: &[Permission] = &[AppsUse, ProfileManageSelf];

/// The permissions granted by a role.
pub fn permissions_for(role: Role) -> &'static [Permission] {
    match role {
        Role::Owner => &Permission::ALL,
        Role::SuperAdmin => P_SUPER_ADMIN,
        Role::Admin => P_ADMIN,
        Role::Security => P_SECURITY,
        Role::Billing => P_BILLING,
        Role::Developer => P_DEVELOPER,
        Role::Support => P_SUPPORT,
        Role::Member | Role::Guest => P_BASELINE,
    }
}

/// Whether `role` grants `perm`.
pub fn role_has(role: Role, perm: Permission) -> bool {
    permissions_for(role).contains(&perm)
}

/// A user's resolved authorization context for the current request.
#[derive(Debug, Clone)]
pub struct RoleContext {
    pub user_id: i32,
    pub scope: Scope,
    pub role: Role,
    pub organization_id: Option<i32>,
}

impl RoleContext {
    pub fn has(&self, perm: Permission) -> bool {
        role_has(self.role, perm)
    }

    /// The role's permissions as `resource:action` strings — what `/api/me`
    /// and `/profile` hand to the frontend for UI gating.
    pub fn permission_strings(&self) -> Vec<String> {
        permissions_for(self.role)
            .iter()
            .map(|perm| perm.as_str().to_string())
            .collect()
    }
}

/// Resolve a user's scope and role from the database.
///
/// Mirrors the precedence the app already used: a `platform_admin` account
/// takes its role from `platform_members`; any account with an
/// `organization_id` takes its role from `organization_members`; everyone else
/// is a personal-workspace owner.
pub async fn resolve_role_context(pool: &PgPool, user_id: i32) -> Result<RoleContext, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT u.account_type, u.organization_id,
               om.role AS organization_role,
               pm.role AS platform_role
        FROM users u
        LEFT JOIN organization_members om
          ON om.organization_id = u.organization_id AND om.user_id = u.id
        LEFT JOIN platform_members pm
          ON pm.user_id = u.id
        WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    let account_type: String = row
        .try_get("account_type")
        .unwrap_or_else(|_| "personal".to_string());
    let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();

    let (scope, role) = if account_type == "platform_admin" {
        let role = row
            .try_get::<Option<String>, _>("platform_role")
            .ok()
            .flatten()
            .map(|stored| Role::from_str(&stored))
            .unwrap_or(Role::Owner);
        (Scope::Platform, role)
    } else if organization_id.is_some() {
        let default = if account_type == "organization_admin" {
            Role::Owner
        } else {
            Role::Member
        };
        let role = row
            .try_get::<Option<String>, _>("organization_role")
            .ok()
            .flatten()
            .map(|stored| Role::from_str(&stored))
            .unwrap_or(default);
        (Scope::Organization, role)
    } else {
        (Scope::Personal, Role::Owner)
    };

    Ok(RoleContext {
        user_id,
        scope,
        role,
        organization_id,
    })
}

/// Authenticate the request and require `perm`. `Err` is a ready-to-return
/// `401` (no/invalid token) or `403` (authenticated but missing the permission).
pub async fn require_permission(
    req: &HttpRequest,
    pool: &PgPool,
    perm: Permission,
) -> Result<RoleContext, HttpResponse> {
    let user_id = get_user_id_from_request(req).ok_or_else(|| {
        HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }))
    })?;

    let ctx = resolve_role_context(pool, user_id).await.map_err(|e| {
        error!(target: "auth", user_id, error = ?e, "rbac role resolution failed");
        HttpResponse::InternalServerError().finish()
    })?;

    if !ctx.has(perm) {
        warn!(
            target: "auth",
            user_id,
            role = ctx.role.as_str(),
            permission = perm.as_str(),
            "rbac permission denied"
        );
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": format!("Missing required permission: {}", perm.as_str())
        })));
    }

    Ok(ctx)
}

/// Like `require_permission`, but also requires the caller to have reach into
/// `organization_id`: platform-scope staff may act on any organization, an
/// organization member only on their own.
pub async fn require_org_access(
    req: &HttpRequest,
    pool: &PgPool,
    organization_id: i32,
    perm: Permission,
) -> Result<RoleContext, HttpResponse> {
    let ctx = require_permission(req, pool, perm).await?;

    let allowed = match ctx.scope {
        Scope::Platform => true,
        Scope::Organization => ctx.organization_id == Some(organization_id),
        Scope::Personal => false,
    };

    if !allowed {
        warn!(
            target: "auth",
            user_id = ctx.user_id,
            organization_id,
            "rbac organization access denied"
        );
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "You do not have access to this organization"
        })));
    }

    Ok(ctx)
}

/// Whether `actor` may change a member's role from `current_role` to `new_role`.
///
/// `roles:manage` holders (owner / super_admin) may make any change.
/// `roles:assign_limited` holders (admin) may only touch members whose current
/// role is below admin and may only assign roles below admin.
pub fn can_assign_role(actor: &RoleContext, current_role: Role, new_role: Role) -> bool {
    if actor.has(RolesManage) {
        return true;
    }
    if actor.has(RolesAssignLimited) {
        return current_role.is_below_admin() && new_role.is_below_admin();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(role: Role) -> RoleContext {
        RoleContext {
            user_id: 1,
            scope: Scope::Organization,
            role,
            organization_id: Some(1),
        }
    }

    #[test]
    fn owner_has_every_permission() {
        for perm in Permission::ALL {
            assert!(role_has(Role::Owner, perm), "owner missing {perm:?}");
        }
    }

    #[test]
    fn super_admin_is_owner_minus_billing() {
        for perm in Permission::ALL {
            let expected = !matches!(perm, BillingManage | BillingRead);
            assert_eq!(
                role_has(Role::SuperAdmin, perm),
                expected,
                "super_admin {perm:?}"
            );
        }
    }

    #[test]
    fn member_and_guest_are_baseline_only() {
        for role in [Role::Member, Role::Guest] {
            assert_eq!(permissions_for(role).len(), 2);
            assert!(role_has(role, AppsUse));
            assert!(role_has(role, ProfileManageSelf));
            assert!(!role_has(role, MembersRead));
            assert!(!role_has(role, MembersManage));
        }
    }

    #[test]
    fn billing_owns_billing_not_security() {
        assert!(role_has(Role::Billing, BillingManage));
        assert!(role_has(Role::Billing, BillingRead));
        assert!(role_has(Role::Billing, UsageRead));
        assert!(!role_has(Role::Billing, SecurityManage));
        assert!(!role_has(Role::Billing, MembersManage));
    }

    #[test]
    fn admin_manages_members_but_not_roles_or_billing() {
        assert!(role_has(Role::Admin, MembersManage));
        assert!(role_has(Role::Admin, RolesAssignLimited));
        assert!(!role_has(Role::Admin, RolesManage));
        assert!(!role_has(Role::Admin, OrgDelete));
        assert!(!role_has(Role::Admin, BillingManage));
    }

    #[test]
    fn developer_owns_api_keys_security_owns_audit() {
        assert!(role_has(Role::Developer, ApiKeysManage));
        assert!(role_has(Role::Developer, WebhooksManage));
        assert!(!role_has(Role::Developer, MembersRead));
        assert!(role_has(Role::Security, AuditRead));
        assert!(role_has(Role::Security, SecurityManage));
        assert!(!role_has(Role::Security, ApiKeysManage));
    }

    #[test]
    fn role_strings_round_trip() {
        for role in Role::ALL {
            assert_eq!(Role::from_str(role.as_str()), role);
        }
        assert_eq!(Role::from_str("bogus"), Role::Member);
        assert_eq!(Role::from_str(""), Role::Member);
    }

    #[test]
    fn assign_limited_cannot_touch_admins_or_grant_admin() {
        let admin = ctx(Role::Admin);
        assert!(can_assign_role(&admin, Role::Member, Role::Developer));
        assert!(can_assign_role(&admin, Role::Guest, Role::Member));
        // may not promote anyone to admin or above
        assert!(!can_assign_role(&admin, Role::Member, Role::Admin));
        assert!(!can_assign_role(&admin, Role::Member, Role::Owner));
        // may not modify an existing admin / super_admin / owner
        assert!(!can_assign_role(&admin, Role::Admin, Role::Member));
        assert!(!can_assign_role(&admin, Role::SuperAdmin, Role::Member));
        assert!(!can_assign_role(&admin, Role::Owner, Role::Member));
    }

    #[test]
    fn roles_manage_holder_can_make_any_change() {
        for actor_role in [Role::Owner, Role::SuperAdmin] {
            let actor = ctx(actor_role);
            assert!(can_assign_role(&actor, Role::Admin, Role::Owner));
            assert!(can_assign_role(&actor, Role::Owner, Role::Member));
        }
    }

    #[test]
    fn member_cannot_assign_any_role() {
        let member = ctx(Role::Member);
        assert!(!can_assign_role(&member, Role::Guest, Role::Member));
    }
}
