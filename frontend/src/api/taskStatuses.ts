import { apiFetch, apiFetchJson } from "./client";

/**
 * The fixed semantic axis a status belongs to. Not user-editable: the product
 * decides what each category *means* (is the task finished, does it belong on
 * the active list), while the user owns the name, colour and ordering within it.
 *
 * Must stay in sync with `CATEGORIES` in
 * `backend/crates/wayve-server/src/tasks/statuses.rs`.
 */
export const STATUS_CATEGORIES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "canceled",
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In Progress",
  completed: "Completed",
  canceled: "Canceled",
};

/**
 * Categories whose tasks count as finished. Mirrors `TERMINAL_CATEGORIES` in
 * the backend — this is what replaced the old `status === "done"` checks, so a
 * renamed completion status no longer breaks the active/completed split.
 */
export const TERMINAL_CATEGORIES: StatusCategory[] = ["completed", "canceled"];

export function isTerminalCategory(category: string): boolean {
  return TERMINAL_CATEGORIES.includes(category as StatusCategory);
}

export type TaskStatusRow = {
  id: number;
  /** Stored in `tasks.status`. Server-generated and immutable once created. */
  slug: string;
  name: string;
  description: string;
  /** `#rrggbb`, lowercase. Applied as an inline style. */
  color: string;
  category: StatusCategory;
  position: number;
  /** Tasks currently on this status, across the owning scope. */
  task_count: number;
};

export type SaveStatusPayload = {
  name: string;
  category: StatusCategory;
  description?: string;
  color?: string;
};

// Statuses change rarely and several pages read them on mount, so this is one
// of the few GETs worth caching. Any mutation clears the whole GET cache, so a
// status edit is reflected immediately rather than after the TTL.
export const getTaskStatuses = async () =>
  apiFetchJson<TaskStatusRow[]>("/api/task-statuses", { cacheTtlMs: 60_000 });

export const createTaskStatus = async (payload: SaveStatusPayload) =>
  apiFetchJson<TaskStatusRow>("/api/task-statuses", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateTaskStatus = async (
  id: number,
  payload: SaveStatusPayload
) =>
  apiFetchJson<TaskStatusRow>(`/api/task-statuses/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

/** Persists a drag-reorder. Returns the full list in its new order. */
export const reorderTaskStatuses = async (ids: number[]) =>
  apiFetchJson<TaskStatusRow[]>("/api/task-statuses/reorder", {
    method: "PUT",
    body: JSON.stringify({ ids }),
  });

/**
 * Deleting a status that tasks still reference fails with a 400 naming the
 * count, unless `reassignTo` names the status to move them onto first. That is
 * deliberate: silently dropping the reference would strand those tasks on a
 * slug with no row, rendering as a blank chip no filter can reach.
 */
export const deleteTaskStatus = async (id: number, reassignTo?: string) => {
  const query = reassignTo
    ? `?reassign_to=${encodeURIComponent(reassignTo)}`
    : "";
  await apiFetch(`/api/task-statuses/${id}${query}`, { method: "DELETE" });
};
