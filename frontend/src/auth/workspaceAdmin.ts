// Who counts as an admin of a workspace for UI gating: owners, super admins
// and admins of an organization or the platform. `effective_role` follows
// admin mode, so an owner in normal mode is not one. UI gating only; the
// backend decides what each caller may read and change.
type AdminUser =
  { scope?: string | null; effective_role?: string | null } | null | undefined;

export function isWorkspaceAdmin(user: AdminUser): boolean {
  return (
    (user?.scope === "organization" || user?.scope === "platform") &&
    ["owner", "super_admin", "admin"].includes(user.effective_role ?? "")
  );
}
