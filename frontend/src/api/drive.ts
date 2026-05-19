import { getApiBase } from "../config/env";
import { apiFetch } from "./client";

export type UploadedFile = {
  id: number;
  name: string;
  file_type: string;
  size: number;
  drive_url?: string;
  created_at: string;
};

// The backend scopes files to the authenticated user (JWT), so no user id
// is passed from the client anymore.
export const getDriveFiles = async () => {
  const res = await apiFetch(`/api/files`);
  return res.json() as Promise<UploadedFile[]>;
};

export const uploadDriveFiles = async (files: File[]) => {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

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
