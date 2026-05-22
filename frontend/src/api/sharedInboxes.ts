// Shared-inbox API client. Mirrors backend/src/routes/shared_inbox.rs.
//
// Two surfaces:
//   1. Admin CRUD over /api/shared-inboxes (gated server-side by `inbox:manage`).
//   2. Workflow updates over /api/shared-inboxes/emails/{id}/state — any user
//      who can read the underlying email (owner or member) may patch state.

import { apiFetch, apiFetchJson } from "./client";

export interface SharedInbox {
  id: number;
  email: string;
  provider: string;
  shared_label: string | null;
  organization_id: number | null;
  is_shared: boolean;
  owner_user_id: number;
  created_at: string;
}

export interface InboxMember {
  account_id: number;
  user_id: number;
  email: string;
  first_name: string | null;
  can_reply: boolean;
  can_manage: boolean;
  created_at: string;
}

export interface InboxState {
  email_id: number;
  status: "open" | "pending" | "closed";
  assignee_id: number | null;
  updated_at: string | null;
  updated_by: number | null;
}

export function listSharedInboxes(): Promise<SharedInbox[]> {
  return apiFetchJson<SharedInbox[]>("/shared-inboxes");
}

export function createSharedInbox(input: {
  account_id: number;
  label?: string;
  organization_id?: number | null;
}): Promise<SharedInbox> {
  return apiFetchJson<SharedInbox>("/shared-inboxes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSharedInbox(
  id: number,
  input: { label?: string; is_shared?: boolean }
): Promise<SharedInbox> {
  return apiFetchJson<SharedInbox>(`/shared-inboxes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteSharedInbox(id: number): Promise<void> {
  await apiFetch(`/shared-inboxes/${id}`, { method: "DELETE" });
}

export function listInboxMembers(id: number): Promise<InboxMember[]> {
  return apiFetchJson<InboxMember[]>(`/shared-inboxes/${id}/members`);
}

export async function addInboxMember(
  id: number,
  input: { user_id: number; can_reply?: boolean; can_manage?: boolean }
): Promise<void> {
  await apiFetch(`/shared-inboxes/${id}/members`, {
    method: "POST",
    body: JSON.stringify({
      user_id: input.user_id,
      can_reply: input.can_reply ?? true,
      can_manage: input.can_manage ?? false,
    }),
  });
}

export async function removeInboxMember(
  id: number,
  userId: number
): Promise<void> {
  await apiFetch(`/shared-inboxes/${id}/members/${userId}`, {
    method: "DELETE",
  });
}

/**
 * Partial-update the workflow state for one email.
 * - status: leave undefined to leave alone
 * - assignee_id: set a user id to assign; leave undefined to leave alone
 * - clear_assignee: true to explicitly unassign (overrides assignee_id)
 */
export function updateEmailState(
  emailId: number,
  patch: {
    status?: "open" | "pending" | "closed";
    assignee_id?: number;
    clear_assignee?: boolean;
  }
): Promise<InboxState> {
  return apiFetchJson<InboxState>(`/shared-inboxes/emails/${emailId}/state`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
