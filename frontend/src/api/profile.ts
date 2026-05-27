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
};

export const getProfile = async () =>
  apiFetchJson<ProfileData>("/api/profile");

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
