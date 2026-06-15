import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

export type TaskStatus = "to_do" | "in_progress" | "in_review" | "done";

export type Task = {
  id: number;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_by: string;
  assignee: string;
  created_at?: string | null;
  updated_at?: string | null;
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
};

export const getTasks = async () => apiFetchJson<Task[]>("/api/tasks");

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
