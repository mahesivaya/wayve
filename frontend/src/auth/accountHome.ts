export type AccountType =
  | "personal"
  | "organization"
  | "organization_admin"
  | "platform_admin";

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

/** Must match the backend slugify(): lowercase, ASCII-alphanumeric only. */
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
  mode?: "normal" | "admin";
  can_switch_admin?: boolean;
};

// Platform team roles land on their own console: the generic platform home only
// carries the org-management surface. Owner, super_admin and admin are absent
// here because they do land on that generic home.
const PLATFORM_ROLE_HOMES: Record<string, string> = {
  billing: "/platform/billing",
  security: "/logs/audit",
  developer: "/platform/developer",
  support: "/platform/support",
  member: "/platform/welcome",
  guest: "/platform/welcome",
};

export function homePathForUser(user?: AccountLike | null): string {
  // A switchable owner defaults to the personal workspace and reaches their admin
  // console only after entering admin mode. The `can_switch_admin` gate keeps a
  // regular member, who is also in mode "normal", on their own scope home.
  if (user?.can_switch_admin && user?.mode !== "admin") {
    return "/home";
  }
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
