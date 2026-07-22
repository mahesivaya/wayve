import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

/**
 * A status *slug*. Was a fixed union of four values; statuses are now
 * user-configurable (see `api/taskStatuses.ts`), so the legal set is per-org
 * data rather than a compile-time constant. Resolve a slug to its name, colour
 * and category through the list returned by `getTaskStatuses`.
 */
export type TaskStatus = string;

export type Task = {
  id: number;
  // Friendly per-user task number, assigned at creation. Null for imported
  // tasks, which show their external Jira or GitLab key badge instead.
  task_number?: number | null;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_by: string;
  assignee: string;
  // The real assigned user, null when only the free-text `assignee` or a
  // reference name is set.
  assignee_id?: number | null;
  project_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  // Set only on tasks imported from Jira or GitLab, and null otherwise. The UI
  // turns each pair into a deep-link badge.
  jira_issue_key?: string | null;
  jira_base?: string | null;
  gitlab_issue_iid?: number | null;
  gitlab_web_url?: string | null;
  // A card badge kind, or absent for a plain ticket. Currently the support-ticket
  // category (bug/feature/billing/account/other) for tickets materialised from a
  // reported bug; the board renders it as a coloured pill.
  badge_kind?: string | null;
};

export type SaveTaskPayload = {
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  // Personal accounts leave these unset, since a task is implicitly owned by its
  // creator. Only business and platform scopes assign to someone else.
  assigned_by?: string;
  assignee?: string;
  assignee_id?: number | null;
  project_id?: number | null;
};

export const getTasks = async () => apiFetchJson<Task[]>("/api/tasks");

// `github_owner` and `github_repo` are set only when the project is linked to a
// public repo, which assignee suggestion requires to work at all.
export type Project = {
  id: number;
  name: string;
  github_owner: string | null;
  github_repo: string | null;
};

export const getProjects = async () => apiFetchJson<Project[]>("/api/projects");

// Ranked by how much and how recently the person worked in the files the task is
// likely to touch. `user_id` is set only for assignable members;
// `is_reference_only` contributors have no Wayve account.
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

// Everyone in the caller's organization, or every platform staff member.
// Assigning is a baseline capability, so unlike the RBAC `/members` endpoints
// this is open to any member of the scope and needs no `members:read`.
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
