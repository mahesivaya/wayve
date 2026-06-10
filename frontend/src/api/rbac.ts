import { apiFetch } from "./client";

// RBAC member-listing and role-management calls. `apiFetch` already throws an
// Error (carrying the backend `message`) on any non-2xx response, so these
// helpers only need to parse the success body.

export type Member = {
  user_id: number;
  email: string;
  username: string | null;
  role: string;
  role_label: string;
};

export type UpdatedRole = {
  user_id: number;
  role: string;
  role_label: string;
};

export async function listOrganizationMembers(
  organizationId: number
): Promise<Member[]> {
  const res = await apiFetch(`/api/organizations/${organizationId}/members`, {
    preserve401: true,
  });
  return res.json();
}

export async function updateOrganizationMemberRole(
  organizationId: number,
  userId: number,
  role: string
): Promise<UpdatedRole> {
  const res = await apiFetch(
    `/api/organizations/${organizationId}/members/${userId}/role`,
    {
      method: "PUT",
      preserve401: true,
      body: JSON.stringify({ role }),
    }
  );
  return res.json();
}

export async function listPlatformMembers(): Promise<Member[]> {
  const res = await apiFetch("/api/platform/members", { preserve401: true });
  return res.json();
}

export async function updatePlatformMemberRole(
  userId: number,
  role: string
): Promise<UpdatedRole> {
  const res = await apiFetch(`/api/platform/members/${userId}/role`, {
    method: "PUT",
    preserve401: true,
    body: JSON.stringify({ role }),
  });
  return res.json();
}

// Response from POST /api/admin/users. `temp_password` is only present when
// the backend generated a password (i.e., the form submitted email + role
// without a password). Surface it to the admin in a "shown once" UI — it
// won't be available on subsequent calls or in any audit log.
export type AdminCreatedUser = {
  id: number;
  username: string | null;
  email: string;
  account_type: string;
  organization_id: number | null;
  role: string;
  temp_password?: string;
};

export type AdminCreateUserInput = {
  email: string;
  role: string;
  // "platform_admin" when called from the platform members panel,
  // "organization" when called from an org context. The backend forces
  // org-context callers to "organization" regardless, so this is mostly a
  // hint for platform admins to create platform-scoped users.
  account_type: "platform_admin" | "organization";
};

export async function adminCreateUser(
  input: AdminCreateUserInput
): Promise<AdminCreatedUser> {
  const res = await apiFetch("/api/admin/users", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      email: input.email,
      role: input.role,
      account_type: input.account_type,
    }),
  });
  return res.json();
}

// Hard-deletes the user. Backend gates this by `members:manage` AND the same
// can_assign_role predicate the role-change endpoint uses — so even with the
// permission, you cannot delete a user whose role you cannot manage. Last
// owner of an org/platform is also protected server-side.
export async function adminDeleteUser(userId: number): Promise<void> {
  await apiFetch(`/api/admin/users/${userId}`, {
    method: "DELETE",
    preserve401: true,
  });
}
