import { apiFetch, apiFetchJson } from "./client";

// Per-organization feature access. The owner controls which roles may use each
// gateable feature (currently the Code Repo viewer). Reading is available to
// any org member (used to gate nav); writing is owner-only (backend enforces).

export type FeatureRow = {
  key: string;
  label: string;
  // Roles currently allowed (resolved: configured set, or the feature default).
  allowed_roles: string[];
  // The code-defined default, shown as a "Reset to default" affordance.
  default_roles: string[];
};

export type FeatureAccess = {
  // Every assignable role, in display order — the matrix columns.
  roles: string[];
  features: FeatureRow[];
};

export const getFeatureAccess = async () =>
  apiFetchJson<FeatureAccess>("/api/feature-access");

export const updateFeatureAccess = async (key: string, roles: string[]) => {
  const res = await apiFetch(`/api/feature-access/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ roles }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to update access");
  }
  return res.json() as Promise<FeatureRow>;
};
