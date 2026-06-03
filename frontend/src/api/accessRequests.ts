import { apiFetchJson } from "./client";

// Mirrors the backend routes in
// backend/crates/wayve-server/src/routes/access_requests.rs.

export type AccessStatus = "none" | "pending" | "approved" | "denied";
export type AccessTarget = "platform" | "organization";

// Response of GET /api/access-requests/me — the caller's own status for a
// resource. `data` is present only when the request is approved.
export type MyAccessStatus = {
  status: AccessStatus;
  target: AccessTarget | null;
  request_note: string | null;
  decision_note: string | null;
  data?: string | null;
};

// A row in the support review queue (GET /api/access-requests/admin).
export type AccessRequestView = {
  id: number;
  user_id: number;
  user_email: string | null;
  resource: string;
  target_scope: AccessTarget;
  organization_id: number | null;
  organization_name: string | null;
  status: Exclude<AccessStatus, "none">;
  request_note: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
};

const DEFAULT_RESOURCE = "test_access";

export const getMyAccessStatus = async (resource: string = DEFAULT_RESOURCE) =>
  apiFetchJson<MyAccessStatus>(
    `/api/access-requests/me?resource=${encodeURIComponent(resource)}`,
  );

// Creates a pending request, or updates the explanation on the existing
// active one (the backend upserts on user+resource).
export const createAccessRequest = async (
  resource: string = DEFAULT_RESOURCE,
  note?: string,
) =>
  apiFetchJson<{ id: number; status: AccessStatus }>("/api/access-requests", {
    method: "POST",
    body: JSON.stringify({ resource, note }),
  });

export const adminListAccessRequests = async (
  status?: Exclude<AccessStatus, "none">,
) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetchJson<AccessRequestView[]>(
    `/api/access-requests/admin${qs}`,
  );
};

export const adminDecideAccessRequest = async (
  id: number,
  status: "approved" | "denied",
  note?: string,
) =>
  apiFetchJson<{ id: number; status: AccessStatus }>(
    `/api/access-requests/admin/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    },
  );
