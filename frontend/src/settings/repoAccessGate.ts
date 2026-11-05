import { hasPermission } from "../auth/permissions";
import type { useAuth } from "../auth/useAuth";

// Who may manage a repository's access. UI gating only: the server decides.
export function canManageRepoAccess(
  user: ReturnType<typeof useAuth>["user"]
): boolean {
  return (
    user?.account_type === "personal" ||
    user?.effective_role === "owner" ||
    hasPermission(user, "members:manage")
  );
}
