import { apiFetch, apiFetchJson } from "./client";
import type { Task, SaveTaskPayload, TaskAttachment } from "./tasks";
import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";

// Workspace tickets are a second Tasks-style board, independent of user stories.
// They reuse the Task record shape (task_number carries the per-owner ticket
// number; the Jira/GitLab fields are always null) and the SaveTaskPayload write
// shape, so the shared Tasks component needs no new type. Statuses, projects and
// assignable-users are the same endpoints as tasks — only the CRUD surface
// differs — so only these four are re-pointed at /api/workspace-tickets.

// Fired after any ticket write so a mounted sidebar badge refreshes its
// open-count immediately instead of waiting for the next poll.
export const TICKETS_CHANGED_EVENT = "rwayve:tickets-changed";

const emitTicketsChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TICKETS_CHANGED_EVENT));
  }
};

export const getTickets = async () =>
  apiFetchJson<Task[]>("/api/workspace-tickets");

// Count of tickets not in a terminal (completed/canceled) column — server-side
// so the sidebar badge is one cheap query, not a full list fetch.
export const getTicketsOpenCount = async () =>
  apiFetchJson<{ count: number }>("/api/workspace-tickets/open-count").then(
    (r) => r.count
  );

export const createTicketApi = async (payload: SaveTaskPayload) => {
  const ticket = await apiFetchJson<Task>("/api/workspace-tickets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  emitTicketsChanged();
  return ticket;
};

export const updateTicketApi = async (id: number, payload: SaveTaskPayload) => {
  const ticket = await apiFetchJson<Task>(`/api/workspace-tickets/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  emitTicketsChanged();
  return ticket;
};

export const deleteTicketApi = async (id: number) => {
  await apiFetch(`/api/workspace-tickets/${id}`, { method: "DELETE" });
  emitTicketsChanged();
};

// On-demand AI pass: Claude groups the board's tickets into duplicate / similar
// clusters and labels them (related_to + relation_kind). Returns the counts so
// the UI can report them; dispatches the change event so the board reloads.
export type FindRelatedResult = {
  groups: { kind: "duplicate" | "similar"; ids: number[] }[];
  duplicates: number;
  similar: number;
};

export const findRelatedTickets = async () => {
  const result = await apiFetchJson<FindRelatedResult>(
    "/api/workspace-tickets/find-related",
    { method: "POST" }
  );
  emitTicketsChanged();
  return result;
};

// Kick off the Claude Code CI fixer for one ticket: the backend recalls a
// similar past fix and dispatches the ai-fix-ticket workflow, which opens a PR.
export type AiFixResult = {
  dispatched: boolean;
  reused_fix_from: number | null;
};

export const aiFixTicket = async (id: number) =>
  apiFetchJson<AiFixResult>(`/api/workspace-tickets/${id}/ai-fix`, {
    method: "POST",
  });

// The AI-fix review state for one ticket. CI posts the diff + changed files here
// (status 'ready'); the ticket page then drives three GitHub steps in order:
// Commit ('committed') → Push ('pushed') → Create PR ('pr_opened'). 'running' =
// CI in flight; 'no_change'/'error' = the run produced nothing to review.
export type AiFixStatus =
  | "running"
  | "ready"
  | "committed"
  | "pushed"
  | "pr_opened"
  | "no_change"
  | "error";

export type AiFixState = {
  status: AiFixStatus | null;
  diff: string | null;
  commit_sha: string | null;
  branch: string | null;
  pr_url: string | null;
};

export const getAiFixState = async (id: number) =>
  apiFetchJson<AiFixState>(`/api/workspace-tickets/${id}/ai-fix`);

// Step 1: create the commit object on GitHub from the reviewed change. Idempotent.
export const commitAiFix = async (id: number) =>
  apiFetchJson<{ commit_sha: string }>(
    `/api/workspace-tickets/${id}/ai-fix-commit`,
    { method: "POST" }
  );

// Step 2: create the branch ref pointing at the commit (the "push"). Idempotent.
export const pushAiFix = async (id: number) =>
  apiFetchJson<{ branch: string }>(`/api/workspace-tickets/${id}/ai-fix-push`, {
    method: "POST",
  });

// Step 3: open the PR from the pushed branch into main. Idempotent — returns the
// existing PR url if one was already opened.
export const openAiFixPr = async (id: number) =>
  apiFetchJson<{ pr_url: string }>(
    `/api/workspace-tickets/${id}/ai-fix-open-pr`,
    { method: "POST" }
  );

// Ticket attachments. Ticket-scoped mirror of the task-attachment API (see
// api/tasks.ts). The backend serializes rows with `task_id` set to the ticket
// id, so they satisfy the shared `TaskAttachment` type the board expects.
export const listTicketAttachments = async (ticketId: number) =>
  apiFetchJson<TaskAttachment[]>(
    `/api/workspace-tickets/${ticketId}/attachments`
  );

// Raw fetch (not apiFetch) so the browser sets the multipart boundary.
export const uploadTicketAttachments = async (
  ticketId: number,
  files: File[]
): Promise<TaskAttachment[]> => {
  if (files.length === 0) return [];
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  const token = getAuthToken();
  const res = await fetch(
    `${getApiBase()}/api/workspace-tickets/${ticketId}/attachments`,
    {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    }
  );
  if (!res.ok) {
    let message = "Attachment upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      const text = await res.text();
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
  return res.json() as Promise<TaskAttachment[]>;
};

export const deleteTicketAttachment = async (id: number) => {
  await apiFetch(`/api/ticket-attachments/${id}`, { method: "DELETE" });
};

export const downloadTicketAttachment = async (
  attachment: TaskAttachment
): Promise<void> => {
  const res = await apiFetch(
    `/api/ticket-attachments/${attachment.id}/download`
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = attachment.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
