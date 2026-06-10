import { getApiBase } from "../config/env";
import { apiFetch, apiFetchJson } from "./client";
import { getAuthToken } from "../auth/token";

export type UploadedFile = {
  id: number;
  name: string;
  file_type: string;
  size: number;
  drive_url?: string;
  created_at: string;
  shared?: boolean;
  permission?: string | null;
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
  parentFolderId: number | null = null
) =>
  apiFetchJson<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
  });

export const deleteFolder = async (folderId: number) => {
  const res = await apiFetch(`/api/folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Delete folder failed");
};

/**
 * Upload files to drive. When `userId` is provided, each file is wrapped
 * in the WV1 binary envelope (E2E) before upload — the server only ever
 * sees ciphertext. We keep the original filename in the form field (it's
 * stored plaintext on the server today; encrypted-filename is a follow-up).
 *
 * `userId == null` is the legacy plaintext upload path; kept as an
 * escape hatch for pre-keypair users, but the caller (DriveBox) always
 * supplies userId once the key is set up.
 */
export const uploadDriveFiles = async (
  files: File[],
  folderId: number | null = null,
  userId: number | null = null
) => {
  const formData = new FormData();

  // IMPORTANT: append folder_id BEFORE the files. The backend streams
  // multipart fields in order and inserts each file as it reads it, using the
  // folder_id seen so far — so if folder_id trails the files it's parsed too
  // late and every file is stored at root (folder_id = NULL). Sending it first
  // matches the backend's "non-file fields first" assumption.
  if (folderId != null) {
    formData.append("folder_id", String(folderId));
  }

  if (userId != null) {
    const { encryptBlobForSelf } = await import("../crypto/fileEnvelope");
    for (const file of files) {
      // Encrypted blob is wrapped in a File with the original name so
      // the multipart filename field still surfaces "report.pdf" to the
      // backend handler (used for the DB row's name column). The bytes
      // inside are opaque WV1 envelope.
      const ciphertext = await encryptBlobForSelf(file, userId);
      formData.append(
        "files",
        new File([ciphertext], file.name, { type: "application/octet-stream" })
      );
    }
  } else {
    files.forEach((file) => formData.append("files", file));
  }

  // Raw fetch (not apiFetch) so the browser sets the multipart boundary.
  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/files`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });

  if (!res.ok) {
    let message = "Upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      const text = await res.text();
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
};

/**
 * Download a drive file. When the bytes start with the WV1 envelope
 * magic, decrypt client-side before handing the browser the blob.
 * Pre-E2E plaintext files pass through unchanged so existing rows
 * keep working through the migration.
 */
export const downloadDriveFile = async (
  fileId: number,
  fileName: string,
  userId: number | null = null
) => {
  const res = await apiFetch(`/api/files/${fileId}/download`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const raw = new Uint8Array(await res.arrayBuffer());

  let blob: Blob;
  if (userId != null) {
    const { looksLikeEnvelope, decryptBlobForSelf } =
      await import("../crypto/fileEnvelope");
    blob = looksLikeEnvelope(raw)
      ? await decryptBlobForSelf(raw, userId, ct)
      : new Blob([raw], { type: ct });
  } else {
    blob = new Blob([raw], { type: ct });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
};
