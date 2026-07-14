import { apiFetch, apiFetchJson } from "./client";

// Per-organization feature access: the owner controls which roles may use each
// gateable feature. Any org member may read it, to gate nav, but writing is
// owner-only and the backend enforces that.

export type FeatureRow = {
  key: string;
  label: string;
  // The resolved allowed set, being either the configured roles or, failing
  // that, the code-defined `default_roles`.
  allowed_roles: string[];
  default_roles: string[];
};

export type FeatureAccess = {
  // Every assignable role, in display order; these are the matrix columns.
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
