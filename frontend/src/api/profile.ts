import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type ProfileData = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  auth_provider: string;
  // Null when the user has never uploaded an image, in which case clients fall
  // back to a generated initial.
  avatar_url?: string | null;
  account_type?: string;
  effective_role?: string | null;
  role_label?: string | null;
  organization_id?: number | null;
  organization_name?: string | null;
  // Storage usage against the plan's limit. A `memory_limit_bytes` of zero or
  // less means unlimited, as on org and enterprise plans.
  total_emails?: number;
  email_storage_bytes?: number;
  drive_storage_bytes?: number;
  other_storage_bytes?: number;
  memory_used_bytes?: number;
  memory_limit_bytes?: number;
};

// Cached because /profile and /settings both call this and remount on
// navigation. The non-GET calls below clear that cache, so a form never shows
// stale name or storage data after a save.
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

// Raw fetch rather than apiFetch so the browser sets the multipart boundary,
// mirroring the drive upload.
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

export const deleteAvatar = async (): Promise<void> => {
  const res = await apiFetch("/api/profile/avatar", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to remove photo");
};

// `theme` is the serialized ThemeChoice JSON that src/theme/CustomThemeContext.tsx
// produces, or null to clear the preference and revert to the stylesheet default.
export const putTheme = async (theme: string | null) =>
  apiFetchJson<{ theme: string | null }>("/api/me/theme", {
    method: "PUT",
    body: JSON.stringify({ theme }),
  });

// Toggles whether chat file attachments this user sends are end-to-end
// encrypted.
export const putChatEncryptFiles = async (enabled: boolean) =>
  apiFetchJson<{ chat_encrypt_files: boolean }>("/api/me/chat-encrypt-files", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });

// Lead time, in minutes, for the meeting alert popup. 0 turns meeting alerts
// off. The server rejects anything outside MEETING_ALERT_CHOICES.
export const putMeetingAlertMinutes = async (minutes: number) =>
  apiFetchJson<{ meeting_alert_minutes: number }>(
    "/api/me/meeting-alert-minutes",
    { method: "PUT", body: JSON.stringify({ minutes }) }
  );
