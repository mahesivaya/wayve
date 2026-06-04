export type AccountType = "personal" | "organization" | "organization_admin" | "platform_admin";

export function normalizeAccountType(accountType?: string | null): AccountType {
  if (accountType === "organization_admin") {
    return "organization_admin";
  }

  if (accountType === "organization") {
    return "organization";
  }

  if (accountType === "platform_admin") {
    return "platform_admin";
  }

  return "personal";
}

/**
 * Mirrors the backend slugify(): lowercase, ASCII-alphanumeric only.
 */
export const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

export const getEmailDomain = (slug?: string | null) =>
  slug ? `${slug}.com` : "wayve.com";

export function homePathForAccount(accountType?: string | null) {
  const normalized = normalizeAccountType(accountType);
  if (normalized === "platform_admin") return "/platform/home";
  if (normalized === "organization_admin" || normalized === "organization") {
    return "/organization/home";
  }
  return "/home";
}

type AccountLike = {
  account_type?: string | null;
  organization_id?: number | null;
  permissions?: string[] | null;
  effective_role?: string | null;
};

// Landing route for a fully-resolved user. The app intentionally has three
// dashboard surfaces: personal, organization, and platform. Role-specific
// panels are handled inside the dashboard with RBAC permissions.
//
// Platform team roles land on their own console — the generic platform admin
// home only has the org-management surface, so anything role-specific gets
// its own page. Owner / super_admin / admin still land on the generic home.
const PLATFORM_ROLE_HOMES: Record<string, string> = {
  billing: "/platform/billing",
  security: "/logs/audit",
  developer: "/platform/developer",
  support: "/platform/support",
  member: "/platform/welcome",
  guest: "/platform/welcome",
};

export function homePathForUser(user?: AccountLike | null): string {
  const normalized = normalizeAccountType(user?.account_type);
  if (normalized === "platform_admin") {
    const role = user?.effective_role ?? "";
    return PLATFORM_ROLE_HOMES[role] ?? "/platform/home";
  }
  if (normalized === "organization_admin" || normalized === "organization") {
    return "/organization/home";
  }
  if (user?.organization_id != null) return "/organization/home";

  return "/home";
}
