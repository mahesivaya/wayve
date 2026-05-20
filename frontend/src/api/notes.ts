import { apiFetch, apiFetchJson } from "./client";

export type Note = {
  id: number;
  title: string | null;
  content: string | null;
  updated_at?: string | null;
};

export type SaveNotePayload = {
  title: string;
  content: string;
};

export const getNotes = async () => apiFetchJson<Note[]>("/api/notes");

export const createNoteApi = async (payload: SaveNotePayload) =>
  apiFetchJson<Note>("/api/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateNoteApi = async (id: number, payload: SaveNotePayload) =>
  apiFetchJson<Note>(`/api/notes/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteNoteApi = async (id: number) => {
  await apiFetch(`/api/notes/${id}`, {
    method: "DELETE",
  });
};
