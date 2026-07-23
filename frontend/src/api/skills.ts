import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";
import type { DocumentFolder, DocumentFile } from "./documents";

// The Skills page is a second shared-workspace file tree, distinct from the
// Documents ("library") page but backed by the same server handlers over a
// "skills" collection (see backend documents/mod.rs). These calls are the
// Documents API pointed at /api/skills + /api/skill-folders; the shapes are
// identical, so we reuse DocumentFolder / DocumentFile.
export type { DocumentFolder, DocumentFile } from "./documents";

// A built-in Claude skill from the repository (read-only). Surfaced alongside
// the uploadable/creatable files so the team can browse the agent skills.
export type SkillCatalogEntry = {
  name: string;
  description: string;
  content: string;
};

async function errMessage(res: Response): Promise<string | null> {
  try {
    const data = await res.clone().json();
    return data?.message ?? data?.error ?? null;
  } catch {
    const text = await res.text().catch(() => "");
    return text.trim() || null;
  }
}

export const listSkillCatalog = async () =>
  apiFetchJson<SkillCatalogEntry[]>("/api/skills/catalog");

export const listSkillFolders = async (
  parentFolderId: number | null = null
) => {
  const qs =
    parentFolderId != null ? `?parent_folder_id=${parentFolderId}` : "";
  return apiFetchJson<DocumentFolder[]>(`/api/skill-folders${qs}`);
};

export const createSkillFolder = async (
  name: string,
  parentFolderId: number | null = null
) => {
  const res = await apiFetch("/api/skill-folders", {
    method: "POST",
    body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to create folder");
  return res.json() as Promise<DocumentFolder>;
};

export const renameSkillFolder = async (folderId: number, name: string) => {
  const res = await apiFetch(`/api/skill-folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to rename folder");
};

export const deleteSkillFolder = async (folderId: number) => {
  const res = await apiFetch(`/api/skill-folders/${folderId}`, {
    method: "DELETE",
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to delete folder");
};

export const listSkillFiles = async (folderId: number | null = null) => {
  const qs = folderId != null ? `?folder_id=${folderId}` : "";
  return apiFetchJson<DocumentFile[]>(`/api/skills${qs}`);
};

export const uploadSkillFiles = async (
  files: File[],
  folderId: number | null = null
) => {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  if (folderId != null) formData.append("folder_id", String(folderId));

  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/skills`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!res.ok) throw new Error((await errMessage(res)) ?? "Upload failed");
};

export const renameSkillFile = async (fileId: number, name: string) => {
  const res = await apiFetch(`/api/skills/${fileId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to rename file");
};

export const deleteSkillFile = async (fileId: number) => {
  const res = await apiFetch(`/api/skills/${fileId}`, { method: "DELETE" });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to delete file");
};

export const createTextSkill = async (
  name: string,
  content: string,
  folderId: number | null = null
) => {
  const res = await apiFetch("/api/skills/new", {
    method: "POST",
    body: JSON.stringify({ name, content, folder_id: folderId }),
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to create document");
  return res.json() as Promise<DocumentFile>;
};

export const getSkillContent = async (fileId: number) => {
  return apiFetchJson<{ name: string; content: string }>(
    `/api/skills/${fileId}/content`
  );
};

export const updateSkillContent = async (fileId: number, content: string) => {
  const res = await apiFetch(`/api/skills/${fileId}/content`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  if (!res.ok)
    throw new Error((await errMessage(res)) ?? "Failed to save document");
};

export const downloadSkillFile = async (fileId: number, fileName: string) => {
  const res = await apiFetch(`/api/skills/${fileId}/download`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(await res.arrayBuffer())], {
    type: ct,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
