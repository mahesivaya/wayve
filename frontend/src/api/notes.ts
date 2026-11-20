import { apiFetch, apiFetchJson } from "./client";

export type Note = {
  id: number;
  title: string | null;
  content: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SaveNotePayload = {
  title: string;
  content: string;
};

// A row of the list: everything but the text, which can be large. The whole
// note comes from getNote when it's opened.
export type NoteSummary = Omit<Note, "content">;

export type NotesPage = {
  notes: NoteSummary[];
  // How many notes match, across every page.
  total: number;
  has_more: boolean;
};

export type NotesQuery = {
  limit?: number;
  offset?: number;
  sort?: "name" | "created" | "edited";
  dir?: "asc" | "desc";
  q?: string;
};

export const NOTES_PAGE_SIZE = 50;

export const getNotes = async (query: NotesQuery = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return apiFetchJson<NotesPage>(`/api/notes${qs ? `?${qs}` : ""}`);
};

// null when the note no longer exists (or was never the caller's).
export const getNote = async (id: number): Promise<Note | null> => {
  const res = await apiFetch(`/api/notes/${id}`, { preserve404: true });
  if (res.status === 404) return null;
  return res.json() as Promise<Note>;
};

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
