import { apiFetch, apiFetchJson } from "./client";
import type { Task, SaveTaskPayload, TaskAttachment } from "./tasks";
import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { announceChange } from "../utils/crossTabEvents";

// Workspace user stories reuse the Task record shape (task_number carries the
// per-owner story number; the Jira/GitLab fields are always null) and the
// SaveTaskPayload write shape, so the shared Tasks component needs no new type.
// Statuses, projects, assignable-users and assignee suggestion are the same
// endpoints as tasks — only the CRUD surface differs — so only these four are
// re-pointed at /api/user-stories.

// Fired after any story mutation so live views (e.g. the admin-dashboard burnup,
// the sidebar badge) can refetch immediately instead of waiting for a reload.
// Reaches other open tabs too, via crossTabEvents.
export const USER_STORIES_CHANGED_EVENT = "rwayve:userstories-changed";
const emitUserStoriesChanged = () => announceChange(USER_STORIES_CHANGED_EVENT);

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

// Story attachments. Story-scoped mirror of the task and ticket attachment APIs
// (see api/tasks.ts, api/tickets.ts). The backend serializes rows with `task_id`
// set to the story id, so they satisfy the shared `TaskAttachment` type.
export const listStoryAttachments = async (storyId: number) =>
  apiFetchJson<TaskAttachment[]>(`/api/user-stories/${storyId}/attachments`);

// Raw fetch (not apiFetch) so the browser sets the multipart boundary.
export const uploadStoryAttachments = async (
  storyId: number,
  files: File[]
): Promise<TaskAttachment[]> => {
  if (files.length === 0) return [];
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  const token = getAuthToken();
  const res = await fetch(
    `${getApiBase()}/api/user-stories/${storyId}/attachments`,
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

export const deleteStoryAttachment = async (id: number) => {
  await apiFetch(`/api/story-attachments/${id}`, { method: "DELETE" });
};

export const downloadStoryAttachment = async (
  attachment: TaskAttachment
): Promise<void> => {
  const res = await apiFetch(
    `/api/story-attachments/${attachment.id}/download`
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

// Per-day, per-status story counts over [from, to] (both "YYYY-MM-DD").
// `counts` maps a status slug to the number of stories in that status on that
// day. See the backend `user_story_status_history` handler.
//
// No caller today: the summary card that used to draw these as trend lines is
// now a per-story timeline built from the stories themselves. Kept because the
// endpoint is live and this is the only client for it.
export type StatusHistoryDay = {
  date: string;
  counts: Record<string, number>;
};

// One story's own status timeline: the status it moved to, and when. Ordered
// oldest first, and deliberately including events from before the requested
// window — the latest one before it is the status the story was already in when
// the window opened. See the backend `user_story_status_timeline` handler.
export type StoryStatusEvent = { at: string; status: string };
export type StoryStatusTimeline = { id: number; events: StoryStatusEvent[] };

export const getUserStoryStatusTimeline = async (
  from: string,
  to: string
): Promise<StoryStatusTimeline[]> => {
  const data = await apiFetchJson<{ stories: StoryStatusTimeline[] }>(
    `/api/user-stories/status-timeline?from=${from}&to=${to}`
  );
  return data.stories;
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
