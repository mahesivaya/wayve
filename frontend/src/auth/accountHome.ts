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
  if (normalized === "platform_admin") return "/platform-admin-home";
  if (normalized === "organization_admin" || normalized === "organization") {
    return "/organization-home";
  }
  return "/home";
}

// Pricing is for accounts that manage their own billing — personal users,
// organization admins, and platform admins. Regular organization members are
// covered by the organization's subscription, so pricing is hidden and the
// /pricing route is guarded against them.
export function canAccessPricing(accountType?: string | null): boolean {
  const normalized = normalizeAccountType(accountType);
  return (
    normalized === "personal" ||
    normalized === "organization_admin" ||
    normalized === "platform_admin"
  );
}

type AccountLike = {
  account_type?: string | null;
  organization_id?: number | null;
  permissions?: string[] | null;
};

export function canAccessPricingForUser(user?: AccountLike | null): boolean {
  if (normalizeAccountType(user?.account_type) === "personal") return true;
  return Boolean(
    user?.permissions?.includes("billing:manage") ||
      user?.permissions?.includes("billing:read")
  );
}

// Landing route for a fully-resolved user. The app intentionally has three
// dashboard surfaces: personal, organization, and platform. Role-specific
// panels are handled inside the dashboard with RBAC permissions.
export function homePathForUser(user?: AccountLike | null): string {
  const normalized = normalizeAccountType(user?.account_type);
  if (normalized === "platform_admin") return "/platform-admin-home";
  if (normalized === "organization_admin" || normalized === "organization") {
    return "/organization-home";
  }
  if (user?.organization_id != null) return "/organization-home";

  return "/home";
}
