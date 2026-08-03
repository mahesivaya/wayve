// RBAC permission catalog and role→permission matrix, mirroring
// backend/src/security/rbac.rs — keep the two in lockstep. The backend remains
// the source of truth for authorization; this copy only gates UI affordances and
// supplies an optimistic permission set before /api/me confirms the real one.

export const PERMISSIONS = [
  "apps:use",
  "apps:manage",
  "profile:manage_self",
  "members:read",
  "members:manage",
  "roles:manage",
  "roles:assign_limited",
  "org:settings",
  "org:delete",
  "billing:manage",
  "billing:read",
  "usage:read",
  "api_keys:manage",
  "webhooks:manage",
  "integrations:manage",
  "logs:read",
  "logs:read_limited",
  "audit:read",
  "security:manage",
  "tickets:manage",
  "sso:manage",
  "inbox:manage",
  // Remote MCP servers: owner / super_admin / admin, and the backend also gates
  // it to the enterprise tier.
  "mcp:manage",
  // Owner-only, not super_admin or admin: the org's AI provider is the owner's
  // call and every member then uses that choice.
  "ai:manage",
  // org_keys:bootstrap is owner-only; org_keys:use_master goes to owner /
  // super_admin / admin but NOT security, for separation of duties.
  "org_keys:bootstrap",
  "org_keys:use_master",
  // Write access to the shared Documents workspace: owner + super_admin only,
  // everyone else is read-only.
  "documents:manage",
  // Editing the org's task statuses: owner / super_admin / admin, alongside
  // org:settings. Reading them is ungated — the task board can't render
  // without the status list.
  "task_statuses:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "owner",
  "super_admin",
  "admin",
  "security",
  "billing",
  "developer",
  "support",
  "member",
  "guest",
] as const;

export type Role = (typeof ROLES)[number];

// `member` and `guest` share the baseline capability bundle.
const BASELINE: Permission[] = ["apps:use", "profile:manage_self"];

// Owner holds the whole catalog. super_admin holds it minus billing, minus
// ai:manage, and minus org_keys:bootstrap — only the original owner may
// bootstrap or promote a key holder. Matches wayve-security/rbac.rs.
const SUPER_ADMIN: Permission[] = PERMISSIONS.filter(
  (perm) =>
    perm !== "billing:manage" &&
    perm !== "billing:read" &&
    perm !== "org_keys:bootstrap" &&
    perm !== "ai:manage"
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  super_admin: SUPER_ADMIN,
  admin: [
    "apps:use",
    "apps:manage",
    "profile:manage_self",
    "members:read",
    "members:manage",
    "roles:assign_limited",
    "org:settings",
    "usage:read",
    "sso:manage",
    "inbox:manage",
    "mcp:manage",
    "org_keys:use_master",
    "task_statuses:manage",
  ],
  security: [
    "apps:use",
    "profile:manage_self",
    "members:read",
    "logs:read",
    "logs:read_limited",
    "audit:read",
    "security:manage",
    "sso:manage",
  ],
  billing: [
    "apps:use",
    "profile:manage_self",
    "members:read",
    "billing:manage",
    "billing:read",
    "usage:read",
  ],
  developer: [
    "apps:use",
    "profile:manage_self",
    "api_keys:manage",
    "webhooks:manage",
    "integrations:manage",
    "logs:read",
    "logs:read_limited",
  ],
  support: [
    "apps:use",
    "profile:manage_self",
    "members:read",
    "usage:read",
    "logs:read_limited",
    "tickets:manage",
  ],
  member: BASELINE,
  guest: BASELINE,
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  super_admin: "Super admin",
  admin: "Admin",
  security: "Security",
  billing: "Billing",
  developer: "Developer",
  support: "Support",
  member: "Member",
  guest: "Guest",
};

/** Unknown or missing values fall back to the least-privileged role, `member`. */
export function normalizeRole(role?: string | null): Role {
  return (ROLES as readonly string[]).includes(role ?? "")
    ? (role as Role)
    : "member";
}

export function permissionsForRole(role?: string | null): Permission[] {
  return [...ROLE_PERMISSIONS[normalizeRole(role)]];
}

// Roles that see neither the Pricing nav link nor the /pricing route, leaving
// access to owner, super_admin and billing. Used by both the sidebar and the
// route guard, so typing the URL cannot bypass the hidden link.
export const PRICING_HIDDEN_ROLES: Role[] = [
  "admin",
  "security",
  "developer",
  "support",
  "guest",
  "member",
];

export function canViewPricing(
  user: { effective_role?: string | null } | null | undefined
): boolean {
  return !PRICING_HIDDEN_ROLES.includes(normalizeRole(user?.effective_role));
}

type ScopedUser = {
  scope?: string | null;
  account_type?: string | null;
  effective_role?: string | null;
};

// `scope` is the authority; account_type is only a fallback for before it
// resolves. The two use different vocabularies, so the account_type
// discriminators have to be mapped onto scopes here.
function resolveScope(user: ScopedUser): string | undefined {
  return (
    user.scope ??
    {
      personal: "personal",
      organization: "organization",
      organization_admin: "organization",
      platform_admin: "platform",
    }[user.account_type ?? ""]
  );
}

/**
 * Visible to personal accounts, for whom it is the only route to connecting a
 * Gmail mailbox, and to the owner of an organization or of the platform. Nobody
 * else is meant to wire up company-wide integrations.
 *
 * UI visibility only. Each integration endpoint keeps its own backend gate, so
 * hiding the page grants no new access; it just stops showing tiles that would
 * 403 anyway.
 */
export function canViewIntegrations(
  user: ScopedUser | null | undefined
): boolean {
  if (!user) return false;
  const scope = resolveScope(user);

  if (scope === "personal") return true;
  if (scope === "organization" || scope === "platform") {
    return normalizeRole(user.effective_role) === "owner";
  }
  return false;
}

/**
 * Whether the Integrations group belongs in the left sidebar. Deliberately
 * narrower than `canViewIntegrations`: a personal account keeps full access to
 * /integrations, but reaches it from the profile menu and Settings rather than
 * from a permanent nav group, so their sidebar stays the apps they use daily.
 *
 * Anyone this returns false for can still open the page — use
 * `canViewIntegrations` for route and menu gating.
 */
export function canViewIntegrationsNav(
  user: ScopedUser | null | undefined
): boolean {
  if (!canViewIntegrations(user)) return false;
  return resolveScope(user as ScopedUser) !== "personal";
}

type PermissionHolder = { permissions?: string[] | null } | null | undefined;

export function hasPermission(
  holder: PermissionHolder,
  perm: Permission
): boolean {
  return Boolean(holder?.permissions?.includes(perm));
}

export function hasAnyPermission(
  holder: PermissionHolder,
  perms: Permission[]
): boolean {
  return perms.some((perm) => hasPermission(holder, perm));
}

// Roles strictly below `admin`: the set a `roles:assign_limited` holder may
// assign or modify. Mirrors `Role::is_below_admin` on the backend.
export const ROLES_BELOW_ADMIN: Role[] = [
  "security",
  "billing",
  "developer",
  "support",
  "member",
  "guest",
];

/**
 * `roles:manage` holders may assign anything; `roles:assign_limited` holders
 * only roles below admin.
 */
export function assignableRoles(actorPermissions?: string[] | null): Role[] {
  if (actorPermissions?.includes("roles:manage")) {
    return [...ROLES];
  }
  if (actorPermissions?.includes("roles:assign_limited")) {
    return [...ROLES_BELOW_ADMIN];
  }
  return [];
}

/**
 * Whether `actor` may change a member currently holding `currentRole`.
 * `roles:assign_limited` holders may not touch owner/super_admin/admin members.
 */
export function canModifyMember(
  actorPermissions: string[] | null | undefined,
  currentRole: string
): boolean {
  if (actorPermissions?.includes("roles:manage")) {
    return true;
  }
  if (actorPermissions?.includes("roles:assign_limited")) {
    return ROLES_BELOW_ADMIN.includes(normalizeRole(currentRole));
  }
  return false;
}

// Stricter than the raw `api_keys:manage` permission, which Developer also holds
// for its own keys: this is the admin-UI gate, not the API gate.
const API_KEY_ADMIN_ROLES: Role[] = ["owner", "super_admin", "admin"];

/**
 * Hidden from personal accounts, which have no admin surface in a workspace of
 * one, and from Developer, who can still call /api/keys for their own keys.
 */
export function canAccessApiKeyAdmin(
  user:
    | { effective_role?: string | null; scope?: string | null }
    | null
    | undefined
): boolean {
  if (!user) return false;
  if (user.scope === "personal") return false;
  return API_KEY_ADMIN_ROLES.includes(normalizeRole(user.effective_role));
}
