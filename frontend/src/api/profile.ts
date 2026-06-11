import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type ProfileData = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  auth_provider: string;
  // Serve URL for the uploaded profile image (/api/users/{id}/avatar), or null
  // when the user has no upload (clients fall back to a generated initial).
  avatar_url?: string | null;
  account_type?: string;
  effective_role?: string | null;
  role_label?: string | null;
  organization_id?: number | null;
  organization_name?: string | null;
  // Storage usage vs the plan's limit. `memory_limit_bytes` <= 0 means
  // unlimited (org/enterprise). Powers the Settings storage row and the
  // global StorageLimitBanner.
  total_emails?: number;
  email_storage_bytes?: number;
  drive_storage_bytes?: number;
  other_storage_bytes?: number;
  memory_used_bytes?: number;
  memory_limit_bytes?: number;
};

// Cached for 30s: /profile and /settings both call this and remount on
// navigation. updateProfile/changePassword are non-GET, so they clear the
// GET cache — the form never shows stale name/storage data after a save.
export const getProfile = async () =>
  apiFetchJson<ProfileData>("/api/profile", { cacheTtlMs: 30_000 });

export const updateProfile = async (data: {
  first_name: string;
  last_name: string;
}) =>
  apiFetchJson<ProfileData>("/api/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });

// Upload (or replace) the current user's profile image. Raw fetch (not
// apiFetch) so the browser sets the multipart boundary — mirrors the drive
// upload. Returns the stable serve URL for the new avatar.
export const uploadAvatar = async (
  file: File
): Promise<{ avatar_url: string }> => {
  const formData = new FormData();
  formData.append("avatar", file);
  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/profile/avatar`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!res.ok) {
    let message = "Avatar upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      const text = await res.text();
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
  return res.json();
};

// Remove the current user's profile image (reverts to the generated initial).
export const deleteAvatar = async (): Promise<void> => {
  const res = await apiFetch("/api/profile/avatar", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to remove photo");
};

// Persist the user's serialized ThemeChoice. `theme` is the JSON string the
// frontend customizer produces (see src/theme/CustomThemeContext.tsx) or null
// to clear the saved preference and revert to the stylesheet default.
export const putTheme = async (theme: string | null) =>
  apiFetchJson<{ theme: string | null }>("/api/me/theme", {
    method: "PUT",
    body: JSON.stringify({ theme }),
  });
