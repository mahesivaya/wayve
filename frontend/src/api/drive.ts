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

// The backend scopes files and folders to the authenticated user. A null
// folder id means the drive root, i.e. rows where folder_id IS NULL.
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

export const renameFolder = async (folderId: number, name: string) =>
  apiFetchJson<{ id: number; name: string }>(`/api/folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteFolder = async (folderId: number) => {
  const res = await apiFetch(`/api/folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Delete folder failed");
};

// The on-disk blob is keyed by UUID, so only the display name changes.
export const renameDriveFile = async (fileId: number, name: string) =>
  apiFetchJson<{ id: number; name: string }>(`/api/files/${fileId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteDriveFile = async (fileId: number) => {
  const res = await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Delete file failed");
};

// With a `userId`, each file is wrapped in the WV1 envelope before upload, so
// the server sees only ciphertext; filenames still go in the clear. A null
// `userId` is the legacy plaintext path for pre-keypair users.
export const uploadDriveFiles = async (
  files: File[],
  folderId: number | null = null,
  userId: number | null = null
) => {
  const formData = new FormData();

  // folder_id must be appended BEFORE the files: the backend streams multipart
  // fields in order and inserts each file as it reads it, so a trailing
  // folder_id is parsed too late and every file lands at the root.
  if (folderId != null) {
    formData.append("folder_id", String(folderId));
  }

  if (userId != null) {
    const { encryptBlobForSelf } = await import("../crypto/fileEnvelope");
    for (const file of files) {
      // Re-wrap the ciphertext in a File under the original name so the
      // multipart filename still reaches the backend for the row's name column.
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
    // A 413 comes from nginx exceeding client_max_body_size, not the backend,
    // and its body is an HTML error page — substitute a readable message.
    if (res.status === 413) {
      throw new Error("File is too large to upload (max 50 MB).");
    }
    let message = "Upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      // Fall back to the response text, but only a short plain message — never
      // a full HTML error page from a proxy.
      const text = (await res.text()).trim();
      if (text && text.length < 200 && !/<\s*html/i.test(text)) {
        message = text;
      }
    }
    throw new Error(message);
  }
};

// Returns a decrypted Blob: bytes carrying the WV1 envelope magic are unwrapped
// client-side, and pre-E2E plaintext files pass through unchanged.
export const fetchDriveFileBlob = async (
  fileId: number,
  userId: number | null = null
): Promise<Blob> => {
  const res = await apiFetch(`/api/files/${fileId}/download`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const raw = new Uint8Array(await res.arrayBuffer());

  if (userId != null) {
    const { looksLikeEnvelope, decryptBlobForSelf } =
      await import("../crypto/fileEnvelope");
    return looksLikeEnvelope(raw)
      ? await decryptBlobForSelf(raw, userId, ct)
      : new Blob([raw], { type: ct });
  }
  return new Blob([raw], { type: ct });
};

export const downloadDriveFile = async (
  fileId: number,
  fileName: string,
  userId: number | null = null
) => {
  const blob = await fetchDriveFileBlob(fileId, userId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
};
