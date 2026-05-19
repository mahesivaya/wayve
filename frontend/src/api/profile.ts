import { apiFetch } from "./client";

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

export const getProfile = async () => {
  const res = await apiFetch("/api/profile");
  return res.json() as Promise<ProfileData>;
};

export const updateProfile = async (data: {
  first_name: string;
  last_name: string;
}) => {
  const res = await apiFetch("/api/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });

  return res.json() as Promise<ProfileData>;
};
