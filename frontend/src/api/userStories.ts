import { apiFetch, apiFetchJson } from "./client";
import type { Task, SaveTaskPayload } from "./tasks";

// Workspace user stories reuse the Task record shape (task_number carries the
// per-owner story number; the Jira/GitLab fields are always null) and the
// SaveTaskPayload write shape, so the shared Tasks component needs no new type.
// Statuses, projects, assignable-users and assignee suggestion are the same
// endpoints as tasks — only the CRUD surface differs — so only these four are
// re-pointed at /api/user-stories.

export const getUserStories = async () =>
  apiFetchJson<Task[]>("/api/user-stories");

export const createUserStoryApi = async (payload: SaveTaskPayload) =>
  apiFetchJson<Task>("/api/user-stories", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateUserStoryApi = async (id: number, payload: SaveTaskPayload) =>
  apiFetchJson<Task>(`/api/user-stories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteUserStoryApi = async (id: number) => {
  await apiFetch(`/api/user-stories/${id}`, { method: "DELETE" });
};
