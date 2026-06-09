import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

async function errMessage(res: Response): Promise<string | null> {
  try {
    const data = await res.clone().json();
    return data?.message ?? data?.error ?? null;
  } catch {
    const text = await res.text().catch(() => "");
    return text.trim() || null;
  }
}

// Organization Documents — a shared workspace where every org member has full
// read/write/delete access. No per-user encryption envelope (the server holds
// the at-rest key and serves blobs to any member), so unlike Drive these calls
// never pass a userId for client-side crypto.

export type DocumentFolder = {
  id: number;
  name: string;
  parent_folder_id: number | null;
  created_at: string;
};

export type DocumentFile = {
  id: number;
  name: string;
  file_type: string | null;
  size: number;
  created_at: string;
};

export const listDocumentFolders = async (parentFolderId: number | null = null) => {
  const qs = parentFolderId != null ? `?parent_folder_id=${parentFolderId}` : "";
  return apiFetchJson<DocumentFolder[]>(`/api/document-folders${qs}`);
};

export const createDocumentFolder = async (
  name: string,
  parentFolderId: number | null = null,
) => {
  const res = await apiFetch("/api/document-folders", {
    method: "POST",
    body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
  });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Failed to create folder");
  return res.json() as Promise<DocumentFolder>;
};

export const renameDocumentFolder = async (folderId: number, name: string) => {
  const res = await apiFetch(`/api/document-folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Failed to rename folder");
};

export const deleteDocumentFolder = async (folderId: number) => {
  const res = await apiFetch(`/api/document-folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Failed to delete folder");
};

export const listDocuments = async (folderId: number | null = null) => {
  const qs = folderId != null ? `?folder_id=${folderId}` : "";
  return apiFetchJson<DocumentFile[]>(`/api/documents${qs}`);
};

export const uploadDocuments = async (
  files: File[],
  folderId: number | null = null,
) => {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  if (folderId != null) formData.append("folder_id", String(folderId));

  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/documents`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Upload failed");
};

export const renameDocument = async (fileId: number, name: string) => {
  const res = await apiFetch(`/api/documents/${fileId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Failed to rename file");
};

export const deleteDocument = async (fileId: number) => {
  const res = await apiFetch(`/api/documents/${fileId}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Failed to delete file");
};

export const downloadDocument = async (fileId: number, fileName: string) => {
  const res = await apiFetch(`/api/documents/${fileId}/download`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(await res.arrayBuffer())], { type: ct });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
