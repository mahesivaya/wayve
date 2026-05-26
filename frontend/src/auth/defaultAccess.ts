// Optimistic permission scaffolding for the moment between login and the
// first /api/me response. The JWT carries no role, so this picks the top
// role for the account type; the live answer overwrites it as soon as the
// server-computed permissions arrive.

import { normalizeAccountType } from "./accountHome";
import { permissionsForRole } from "./permissions";

export type DefaultAccess = {
  effective_role: string;
  role_label: string;
  scope: string;
  permissions: ReturnType<typeof permissionsForRole>;
};

export function defaultAccessForAccount(
  accountType?: string | null,
): DefaultAccess {
  const normalized = normalizeAccountType(accountType);
  if (normalized === "platform_admin") {
    return {
      effective_role: "owner",
      role_label: "Platform owner",
      scope: "platform",
      permissions: permissionsForRole("owner"),
    };
  }
  if (normalized === "organization_admin") {
    return {
      effective_role: "owner",
      role_label: "Organization owner",
      scope: "organization",
      permissions: permissionsForRole("owner"),
    };
  }
  if (normalized === "organization") {
    return {
      effective_role: "member",
      role_label: "Member",
      scope: "organization",
      permissions: permissionsForRole("member"),
    };
  }
  return {
    effective_role: "owner",
    role_label: "Personal workspace owner",
    scope: "personal",
    permissions: permissionsForRole("owner"),
  };
}
