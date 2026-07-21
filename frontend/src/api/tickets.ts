import { apiFetch, apiFetchJson } from "./client";
import type { Task, SaveTaskPayload } from "./tasks";

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
    (r) => r.count,
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
