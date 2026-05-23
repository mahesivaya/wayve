import { apiFetch, apiFetchJson } from "./client";

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

export type Task = {
  id: number;
  name: string;
  description: string;
  priority: TaskPriority;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SaveTaskPayload = {
  name: string;
  description: string;
  priority: TaskPriority;
};

export const getTasks = async () => apiFetchJson<Task[]>("/api/tasks");

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
