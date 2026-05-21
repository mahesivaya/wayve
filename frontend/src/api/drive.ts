import { getApiBase } from "../config/env";
import { apiFetch, apiFetchJson } from "./client";

export type UploadedFile = {
  id: number;
  name: string;
  file_type: string;
  size: number;
  drive_url?: string;
  created_at: string;
};

export type Folder = {
  id: number;
  user_id: number;
  parent_folder_id: number | null;
  name: string;
  created_at: string;
};

// Backend scopes files/folders to the authenticated user (JWT). The
// `folder_id` parameter narrows to a specific folder; `null` (default)
// means "drive root" (rows where folder_id IS NULL on the server).
export const getDriveFiles = async (folderId: number | null = null) => {
  const path =
    folderId == null ? "/api/files" : `/api/files?folder_id=${folderId}`;
  return apiFetchJson<UploadedFile[]>(path);
};

export const listFolders = async (parentFolderId: number | null = null) => {
  const path =
    parentFolderId == null
      ? "/api/folders"
      : `/api/folders?parent_folder_id=${parentFolderId}`;
  return apiFetchJson<Folder[]>(path);
};

export const createFolder = async (
  name: string,
  parentFolderId: number | null = null,
) =>
  apiFetchJson<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
  });

export const deleteFolder = async (folderId: number) => {
  const res = await apiFetch(`/api/folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Delete folder failed");
};

export const uploadDriveFiles = async (
  files: File[],
  folderId: number | null = null,
) => {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  if (folderId != null) {
    formData.append("folder_id", String(folderId));
  }

  // Raw fetch (not apiFetch) so the browser sets the multipart boundary.
  const res = await fetch(`${getApiBase()}/api/files/upload`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  if (!res.ok) {
    throw new Error("Upload failed");
  }
};

// Downloads go through the authenticated, ownership-checked route. The file
// is fetched with the auth header and handed to the browser as a blob, since
// a plain <a href> can't send the Authorization header.
export const downloadDriveFile = async (fileId: number, fileName: string) => {
  const res = await apiFetch(`/api/files/${fileId}/download`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
};
