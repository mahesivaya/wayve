import { apiFetch, apiFetchJson } from "./client";
import type { Task, SaveTaskPayload } from "./tasks";

// Workspace user stories reuse the Task record shape (task_number carries the
// per-owner story number; the Jira/GitLab fields are always null) and the
// SaveTaskPayload write shape, so the shared Tasks component needs no new type.
// Statuses, projects, assignable-users and assignee suggestion are the same
// endpoints as tasks — only the CRUD surface differs — so only these four are
// re-pointed at /api/user-stories.

// Fired after any story mutation so live views (e.g. the admin-dashboard burnup)
// can refetch immediately instead of waiting for a reload. Same-document only —
// listeners pair it with a visibility/focus refetch to catch other-tab edits.
export const USER_STORIES_CHANGED_EVENT = "rwayve:userstories-changed";
const emitUserStoriesChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(USER_STORIES_CHANGED_EVENT));
  }
};

export const getUserStories = async () =>
  apiFetchJson<Task[]>("/api/user-stories");

export const createUserStoryApi = async (payload: SaveTaskPayload) => {
  const story = await apiFetchJson<Task>("/api/user-stories", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  emitUserStoriesChanged();
  return story;
};

export const updateUserStoryApi = async (
  id: number,
  payload: SaveTaskPayload
) => {
  const story = await apiFetchJson<Task>(`/api/user-stories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  emitUserStoriesChanged();
  return story;
};

export const deleteUserStoryApi = async (id: number) => {
  await apiFetch(`/api/user-stories/${id}`, { method: "DELETE" });
  emitUserStoriesChanged();
};

// Per-day, per-status story counts over [from, to] (both "YYYY-MM-DD"), for the
// burnup trend lines. `counts` maps a status slug to the number of stories in
// that status on that day. See the backend `user_story_status_history` handler.
export type StatusHistoryDay = {
  date: string;
  counts: Record<string, number>;
};

export const getUserStoryStatusHistory = async (
  from: string,
  to: string
): Promise<StatusHistoryDay[]> => {
  const data = await apiFetchJson<{ days: StatusHistoryDay[] }>(
    `/api/user-stories/status-history?from=${from}&to=${to}`
  );
  return data.days;
};
