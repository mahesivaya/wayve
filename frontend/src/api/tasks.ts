import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

export type TaskStatus = "to_do" | "in_progress" | "in_review" | "done";

export type Task = {
  id: number;
  // Friendly per-user task number (task #1, #2, … within your own list),
  // assigned at creation. Null for imported tasks, which show their external
  // key badge (Jira/GitLab) instead.
  task_number?: number | null;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_by: string;
  assignee: string;
  // Real assigned user (null when only the free-text `assignee`/a reference
  // name is set) and the project the task belongs to.
  assignee_id?: number | null;
  project_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  // Set only on tasks imported from Jira; the UI shows a deep-link badge to
  // `${jira_base}/browse/${jira_issue_key}`. Null for non-Jira tasks.
  jira_issue_key?: string | null;
  jira_base?: string | null;
  // Set only on tasks imported from GitLab; the UI shows a deep-link badge to
  // `gitlab_web_url`. Null for non-GitLab tasks.
  gitlab_issue_iid?: number | null;
  gitlab_web_url?: string | null;
};

export type SaveTaskPayload = {
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  // Personal accounts leave these unset — a task is implicitly owned by its
  // creator. Only business/platform scopes assign a task to someone else, so
  // their UI supplies both fields.
  assigned_by?: string;
  assignee?: string;
  // The chosen assignee's user id (from a suggestion or the assignable list),
  // and the project the task is created on (set from the form's dropdown).
  assignee_id?: number | null;
  project_id?: number | null;
};

export const getTasks = async () => apiFetchJson<Task[]>("/api/tasks");

// A project the current account owns/belongs to, for the create-task dropdown.
// `github_owner`/`github_repo` are set only when the project is linked to a
// public repo — required for the assignee-suggestion feature to work.
export type Project = {
  id: number;
  name: string;
  github_owner: string | null;
  github_repo: string | null;
};

export const getProjects = async () => apiFetchJson<Project[]>("/api/projects");

// A suggested assignee, ranked by how much/how recently they've worked in the
// files the task is likely to touch. `user_id` is set only for connected
// members (assignable); `is_reference_only` contributors have no Wayve account.
export type AssigneeSuggestion = {
  user_id: number | null;
  github_login: string | null;
  display: string;
  email: string | null;
  is_reference_only: boolean;
  expertise_score: number;
  commits: number;
  recent_commits: number;
  last_activity: string | null;
  reason: string;
};

export type SuggestAssigneeResponse = {
  used_ai: boolean;
  files: string[];
  candidates: AssigneeSuggestion[];
  note?: string;
};

export const suggestAssignee = async (payload: {
  project_id: number;
  summary: string;
  description: string;
}) =>
  apiFetchJson<SuggestAssigneeResponse>("/api/tasks/suggest-assignee", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// A user the current account can assign tasks to (everyone in the caller's
// organization, or every platform staff member). Open to any member of the
// scope — assigning is a baseline capability, so this does NOT require the
// `members:read` permission that the RBAC `/members` endpoints demand.
export type AssignableUser = {
  user_id: number;
  email: string;
  username: string | null;
};

export const getAssignableUsers = async () =>
  apiFetchJson<AssignableUser[]>("/api/tasks/assignable-users");

export const createTaskApi = async (payload: SaveTaskPayload) =>
  apiFetchJson<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateTaskApi = async (id: number, payload: SaveTaskPayload) =>
  apiFetchJson<Task>(`/api/tasks/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteTaskApi = async (id: number) => {
  await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
};

export type TaskAttachment = {
  id: number;
  task_id: number;
  name: string;
  file_type: string | null;
  size: number;
  created_at?: string | null;
};

export const listTaskAttachments = async (taskId: number) =>
  apiFetchJson<TaskAttachment[]>(`/api/tasks/${taskId}/attachments`);

// Raw fetch (not apiFetch) so the browser sets the multipart boundary; the
// JSON Content-Type apiFetch always pins would break the multipart parse.
export const uploadTaskAttachments = async (
  taskId: number,
  files: File[]
): Promise<TaskAttachment[]> => {
  if (files.length === 0) return [];
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/tasks/${taskId}/attachments`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });

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

export const deleteTaskAttachment = async (id: number) => {
  await apiFetch(`/api/task-attachments/${id}`, { method: "DELETE" });
};

export const downloadTaskAttachment = async (
  attachment: TaskAttachment
): Promise<void> => {
  const res = await apiFetch(`/api/task-attachments/${attachment.id}/download`);
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
