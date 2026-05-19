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
