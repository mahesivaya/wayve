import { apiFetch } from "./client";

// `apiFetch` already throws an Error carrying the backend `message` on any
// non-2xx response, so these helpers only parse the success body.

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

// Per-user project access for a platform member. Repos are keyed by GitHub
// `full_name`, i.e. "owner/name", in this and the three calls below.
export async function getPlatformMemberProjects(
  userId: number
): Promise<string[]> {
  const res = await apiFetch(`/api/platform/members/${userId}/projects`, {
    preserve401: true,
  });
  const data = await res.json();
  return Array.isArray(data?.repos) ? (data.repos as string[]) : [];
}

// Replaces the member's granted repo set, returning the persisted list.
export async function setPlatformMemberProjects(
  userId: number,
  repos: string[]
): Promise<string[]> {
  const res = await apiFetch(`/api/platform/members/${userId}/projects`, {
    method: "PUT",
    preserve401: true,
    body: JSON.stringify({ repos }),
  });
  const data = await res.json();
  return Array.isArray(data?.repos) ? (data.repos as string[]) : [];
}

// The same per-member project access, scoped to one organization.
export async function getOrganizationMemberProjects(
  organizationId: number,
  userId: number
): Promise<string[]> {
  const res = await apiFetch(
    `/api/organizations/${organizationId}/members/${userId}/projects`,
    { preserve401: true }
  );
  const data = await res.json();
  return Array.isArray(data?.repos) ? (data.repos as string[]) : [];
}

export async function setOrganizationMemberProjects(
  organizationId: number,
  userId: number,
  repos: string[]
): Promise<string[]> {
  const res = await apiFetch(
    `/api/organizations/${organizationId}/members/${userId}/projects`,
    { method: "PUT", preserve401: true, body: JSON.stringify({ repos }) }
  );
  const data = await res.json();
  return Array.isArray(data?.repos) ? (data.repos as string[]) : [];
}

// Both fetches below return this shape, but the org variant is authorized to the
// caller's own org and the platform variant to platform staff only.
export type MemberStorage = {
  total_bytes: number;
  gmail_bytes: number;
  drive_bytes: number;
  chat_bytes: number;
  notes_bytes: number;
  tasks_bytes: number;
};

export type MemberDetail = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  avatar_path: string | null;
  auth_provider: string | null;
  account_type: string | null;
  email_verified: boolean;
  created_at: string | null;
  organization_id: number | null;
  organization_name: string | null;
  platform_role: string | null;
  organization_role: string | null;
  storage: MemberStorage;
};

export async function getOrganizationMemberDetail(
  organizationId: number,
  userId: number
): Promise<MemberDetail> {
  const res = await apiFetch(
    `/api/organizations/${organizationId}/members/${userId}`,
    { preserve401: true }
  );
  return res.json();
}

// The backend accepts either the member's username, which is the canonical URL,
// or their numeric user id, which legacy links still use.
export async function getPlatformMemberDetail(
  identifier: string | number
): Promise<MemberDetail> {
  const res = await apiFetch(
    `/api/platform/members/${encodeURIComponent(identifier)}`,
    { preserve401: true }
  );
  return res.json();
}

// `temp_password` is present only when the backend generated one. It must be
// surfaced to the admin in a shown-once UI: no later call and no audit log can
// recover it.
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
  // The backend forces org-context callers to "organization" regardless, so
  // this mainly lets platform admins create platform-scoped users.
  account_type: "platform_admin" | "organization";
  // The 6-digit code mailed by sendAdminCreateCode in api/admin.ts. The backend
  // refuses to create the account without a valid one.
  verification_code: string;
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
      verification_code: input.verification_code,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Failed to create user");
  }
  return data;
}

// Hard-deletes the user. The backend gates this on `members:manage` and on the
// same can_assign_role predicate the role-change endpoint uses, so even with the
// permission you cannot delete a user whose role you cannot manage. The last
// owner of a scope is protected server-side too.
export async function adminDeleteUser(userId: number): Promise<void> {
  await apiFetch(`/api/admin/users/${userId}`, {
    method: "DELETE",
    preserve401: true,
  });
}
