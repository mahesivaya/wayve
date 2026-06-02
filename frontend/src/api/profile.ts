import { apiFetchJson } from "./client";

export type ProfileData = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  auth_provider: string;
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

// Persist the user's serialized ThemeChoice. `theme` is the JSON string the
// frontend customizer produces (see src/theme/CustomThemeContext.tsx) or null
// to clear the saved preference and revert to the stylesheet default.
export const putTheme = async (theme: string | null) =>
  apiFetchJson<{ theme: string | null }>("/api/me/theme", {
    method: "PUT",
    body: JSON.stringify({ theme }),
  });
