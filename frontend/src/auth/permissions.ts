// RBAC permission catalog and role→permission matrix.
//
// This mirrors backend/src/security/rbac.rs — keep the two in lockstep. The
// backend is the source of truth for authorization; this module exists so the
// UI can gate panels/buttons, and to derive an optimistic permission set before
// /api/me confirms the real one.

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

// owner = the whole catalog; super_admin = the whole catalog minus billing.
const SUPER_ADMIN: Permission[] = PERMISSIONS.filter(
  (perm) => perm !== "billing:manage" && perm !== "billing:read"
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
  ],
  security: [
    "apps:use",
    "profile:manage_self",
    "members:read",
    "logs:read",
    "logs:read_limited",
    "audit:read",
    "security:manage",
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

/** Human-readable label for a role. */
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

/** Coerce an arbitrary string to a known role; unknown values become `member`. */
export function normalizeRole(role?: string | null): Role {
  return (ROLES as readonly string[]).includes(role ?? "")
    ? (role as Role)
    : "member";
}

/** The permissions a role grants. */
export function permissionsForRole(role?: string | null): Permission[] {
  return [...ROLE_PERMISSIONS[normalizeRole(role)]];
}

type PermissionHolder = { permissions?: string[] | null } | null | undefined;

/** Whether the holder (typically the auth user) has `perm`. */
export function hasPermission(
  holder: PermissionHolder,
  perm: Permission
): boolean {
  return Boolean(holder?.permissions?.includes(perm));
}

/** Whether the holder has at least one of `perms`. */
export function hasAnyPermission(
  holder: PermissionHolder,
  perms: Permission[]
): boolean {
  return perms.some((perm) => hasPermission(holder, perm));
}

// Roles strictly below `admin` — the set a `roles:assign_limited` holder may
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
 * The roles an actor may pick in a role-change dropdown. `roles:manage` holders
 * may assign anything; `roles:assign_limited` holders only roles below admin.
 */
export function assignableRoles(
  actorPermissions?: string[] | null
): Role[] {
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
