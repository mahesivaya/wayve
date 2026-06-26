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

use crate::jwt::get_user_id_from_request;
use actix_web::{HttpRequest, HttpResponse};
use async_trait::async_trait;
use once_cell::sync::OnceCell;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    /// Connect and manage the org's (or the platform's) remote MCP servers,
    /// which let the AI assistant read the customer's own systems. Granted to
    /// owner / super_admin / admin; gated further to the enterprise tier and the
    /// platform scope at the handler. Personal/business accounts never hold the
    /// effective capability (the tier/scope gate rejects them even as owners).
    McpManage,
    /// Select and change the organization's AI provider (which model/endpoint the
    /// AI assistant runs on) and view its usage/cost governance. Granted to the
    /// organization **owner only** — not super_admin/admin — and gated further to
    /// the enterprise tier at the handler. Every member of the org then uses the
    /// owner's chosen provider; members can never change it.
    AiManage,
    /// Bootstrap the org master keypair AND promote a member to a key-holder
    /// role (admin / owner). Granted to owner only — the canonical recovery
    /// root must stay single-owner because the mnemonic is a one-time secret.
    OrgKeysBootstrap,
    /// Use the org master key to fetch a member's escrow envelope, decrypt
    /// their data for offboarding/compliance, or reset their password.
    /// Granted to owner, super_admin, admin. NOT granted to security — they
    /// can provision members (via MembersManage) but not access their
    /// already-existing escrows; that's a separation-of-duties choice.
    OrgKeysUseMaster,
}

impl Permission {
    pub const ALL: [Permission; 26] = [
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
        McpManage,
        AiManage,
        OrgKeysBootstrap,
        OrgKeysUseMaster,
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
            McpManage => "mcp:manage",
            AiManage => "ai:manage",
            OrgKeysBootstrap => "org_keys:bootstrap",
            OrgKeysUseMaster => "org_keys:use_master",
        }
    }
}

// The role→permission matrix. `owner` is the whole catalog; every other role
// lists its grants explicitly (a `logs:read` holder also gets the limited form,
// so both are listed — there is no implication logic).
//
// One declarative source of truth: adding a permission to a role means editing
// exactly one Vec below. The map is built lazily on first lookup and held for
// the lifetime of the process, so `permissions_for` stays O(1) with stable
// 'static slice references for callers that iterate or expose them upward.
//
// `member` and `guest` share the baseline capability bundle; `guest`'s real
// limitation (visibility scoped to explicitly-shared resources) is a data-layer
// concern, not a permission.
static PERMISSION_MATRIX: std::sync::LazyLock<std::collections::HashMap<Role, Vec<Permission>>> =
    std::sync::LazyLock::new(|| {
        let baseline = vec![AppsUse, ProfileManageSelf];
        std::collections::HashMap::from([
            (Role::Owner, Permission::ALL.to_vec()),
            (
                Role::SuperAdmin,
                vec![
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
                    McpManage,
                    // super_admin is everything-except-billing, so the master
                    // key permission is in. Bootstrap is owner-only.
                    OrgKeysUseMaster,
                ],
            ),
            (
                Role::Admin,
                vec![
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
                    McpManage,
                    // Admin holds the org master key (re-wrapped under their
                    // personal pubkey at promotion time) so they can reset
                    // member passwords and recover member data without
                    // bothering the owner. Cannot bootstrap or promote.
                    OrgKeysUseMaster,
                ],
            ),
            (
                Role::Security,
                vec![
                    AppsUse,
                    ProfileManageSelf,
                    MembersRead,
                    // Security can provision new accounts (guest/developer/
                    // member/support) through the admin "Create user" flow.
                    // Granting MembersManage also lets them change roles on
                    // existing members via the same gate; that's intentional —
                    // owner/super_admin still keep all permissions above it.
                    MembersManage,
                    // Paired with MembersManage so security can actually act on
                    // the accounts it provisions — change roles and delete
                    // users — but only for roles below admin. Without this,
                    // can_assign_role would return false for every target.
                    RolesAssignLimited,
                    LogsRead,
                    LogsReadLimited,
                    AuditRead,
                    SecurityManage,
                    SsoManage,
                ],
            ),
            (
                Role::Billing,
                vec![
                    AppsUse,
                    ProfileManageSelf,
                    MembersRead,
                    BillingManage,
                    BillingRead,
                    UsageRead,
                ],
            ),
            (
                Role::Developer,
                vec![
                    AppsUse,
                    ProfileManageSelf,
                    ApiKeysManage,
                    WebhooksManage,
                    IntegrationsManage,
                    LogsRead,
                    LogsReadLimited,
                ],
            ),
            (
                Role::Support,
                vec![
                    AppsUse,
                    ProfileManageSelf,
                    MembersRead,
                    UsageRead,
                    LogsReadLimited,
                    TicketsManage,
                ],
            ),
            (Role::Member, baseline.clone()),
            (Role::Guest, baseline),
        ])
    });

/// The permissions granted by a role.
pub fn permissions_for(role: Role) -> &'static [Permission] {
    static EMPTY: &[Permission] = &[];
    PERMISSION_MATRIX
        .get(&role)
        .map(Vec::as_slice)
        .unwrap_or(EMPTY)
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

/// Pluggable cache that sits in front of [`resolve_role_context`].
///
/// `wayve-security` doesn't know about Redis or moka — it just calls into
/// whatever implementation `wayve-server` registers via [`install_cache`]
/// at startup. When no cache is installed the resolver runs straight
/// against Postgres on every call (existing behavior).
#[async_trait]
pub trait RoleContextCache: Send + Sync {
    async fn get(&self, user_id: i32) -> Option<RoleContext>;
    async fn put(&self, user_id: i32, ctx: &RoleContext);
    async fn invalidate(&self, user_id: i32);
}

static CACHE: OnceCell<Box<dyn RoleContextCache>> = OnceCell::new();

/// Register a `RoleContextCache` implementation. Must be called once at
/// process startup, before any HTTP handlers run. Subsequent calls are
/// silently dropped — the cache is process-global by design so role
/// mutations only need to invalidate one key.
pub fn install_cache(cache: Box<dyn RoleContextCache>) {
    let _ = CACHE.set(cache);
}

/// Drop the cached `RoleContext` for `user_id`. Call this from every
/// handler that mutates `organization_members`, `platform_members`, or
/// `users.account_type`/`users.organization_id` so the next request sees
/// the new role without waiting for the TTL.
pub async fn invalidate_role_context(user_id: i32) {
    if let Some(cache) = CACHE.get() {
        cache.invalidate(user_id).await;
    }
}

/// Resolve a user's scope and role from the database.
///
/// Mirrors the precedence the app already used: a `platform_admin` account
/// takes its role from `platform_members`; any account with an
/// `organization_id` takes its role from `organization_members`; everyone else
/// is a personal-workspace owner.
///
/// When a `RoleContextCache` is installed the lookup is served from cache
/// on hit (typical case for back-to-back requests in the same session);
/// on miss we fall through to the SQL below and write the result back.
pub async fn resolve_role_context(pool: &PgPool, user_id: i32) -> Result<RoleContext, sqlx::Error> {
    if let Some(cache) = CACHE.get()
        && let Some(cached) = cache.get(user_id).await
    {
        return Ok(cached);
    }

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

    let ctx = RoleContext {
        user_id,
        scope,
        role,
        organization_id,
    };

    if let Some(cache) = CACHE.get() {
        cache.put(user_id, &ctx).await;
    }

    Ok(ctx)
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

/// Authenticate the request and require the caller be the OWNER of a platform
/// or organization scope. Stricter than any single permission: even roles that
/// hold the relevant permission (super_admin, security, …) are rejected, and
/// personal accounts are excluded. Used to lock the audit views to owners only.
pub async fn require_owner(req: &HttpRequest, pool: &PgPool) -> Result<RoleContext, HttpResponse> {
    let user_id = get_user_id_from_request(req).ok_or_else(|| {
        HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" }))
    })?;

    let ctx = resolve_role_context(pool, user_id).await.map_err(|e| {
        error!(target: "auth", user_id, error = ?e, "rbac role resolution failed");
        HttpResponse::InternalServerError().finish()
    })?;

    if ctx.role != Role::Owner || ctx.scope == Scope::Personal {
        warn!(
            target: "auth",
            user_id,
            role = ctx.role.as_str(),
            scope = ctx.scope.as_str(),
            "rbac owner-only access denied"
        );
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization or platform owner can access this."
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
            // super_admin is everything except billing, the owner-only key
            // bootstrap, and the owner-only AI provider control.
            let expected = !matches!(
                perm,
                BillingManage | BillingRead | OrgKeysBootstrap | AiManage
            );
            assert_eq!(
                role_has(Role::SuperAdmin, perm),
                expected,
                "super_admin {perm:?}"
            );
        }
    }

    #[test]
    fn ai_manage_is_owner_only() {
        assert!(role_has(Role::Owner, AiManage));
        for role in [
            Role::SuperAdmin,
            Role::Admin,
            Role::Security,
            Role::Billing,
            Role::Developer,
            Role::Support,
            Role::Member,
            Role::Guest,
        ] {
            assert!(!role_has(role, AiManage), "{role:?} must NOT have AiManage");
        }
    }

    #[test]
    fn org_keys_bootstrap_is_owner_only() {
        assert!(role_has(Role::Owner, OrgKeysBootstrap));
        for role in [
            Role::SuperAdmin,
            Role::Admin,
            Role::Security,
            Role::Billing,
            Role::Developer,
            Role::Support,
            Role::Member,
            Role::Guest,
        ] {
            assert!(
                !role_has(role, OrgKeysBootstrap),
                "{role:?} must NOT have OrgKeysBootstrap"
            );
        }
    }

    #[test]
    fn org_keys_use_master_is_owner_super_admin_admin() {
        for role in [Role::Owner, Role::SuperAdmin, Role::Admin] {
            assert!(
                role_has(role, OrgKeysUseMaster),
                "{role:?} must have OrgKeysUseMaster"
            );
        }
        for role in [
            Role::Security,
            Role::Billing,
            Role::Developer,
            Role::Support,
            Role::Member,
            Role::Guest,
        ] {
            assert!(
                !role_has(role, OrgKeysUseMaster),
                "{role:?} must NOT have OrgKeysUseMaster"
            );
        }
    }

    #[test]
    fn mcp_manage_is_owner_super_admin_admin() {
        for role in [Role::Owner, Role::SuperAdmin, Role::Admin] {
            assert!(role_has(role, McpManage), "{role:?} must have McpManage");
        }
        for role in [
            Role::Security,
            Role::Billing,
            Role::Developer,
            Role::Support,
            Role::Member,
            Role::Guest,
        ] {
            assert!(
                !role_has(role, McpManage),
                "{role:?} must NOT have McpManage"
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
