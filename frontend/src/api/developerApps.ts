import { apiFetch } from "./client";

// Developer-app (integration) registration calls. `apiFetch` throws an Error
// carrying the backend `message` on any non-2xx, so these helpers only parse
// the body. Mirrors the api/apiKeys.ts shape.

export type DeveloperApp = {
  id: number;
  name: string;
  description: string | null;
  homepage_url: string | null;
  client_id: string;
  client_secret_preview: string;
  redirect_uris: string[];
  scopes: string[];
  user_id: number;
  organization_id: number | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

// Create additionally carries the raw client secret — shown exactly once.
export type CreatedDeveloperApp = DeveloperApp & { client_secret: string };

// Rotate returns only the new secret (once) and its preview.
export type RotatedSecret = {
  id: number;
  client_secret_preview: string;
  client_secret: string;
};

export type CreateDeveloperAppInput = {
  name: string;
  description?: string | null;
  homepage_url?: string | null;
  redirect_uris: string[];
  scopes: string[];
};

export async function createDeveloperApp(
  input: CreateDeveloperAppInput
): Promise<CreatedDeveloperApp> {
  const res = await apiFetch("/api/developer/apps", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function listDeveloperApps(): Promise<DeveloperApp[]> {
  const res = await apiFetch("/api/developer/apps", { preserve401: true });
  return res.json();
}

export async function rotateDeveloperAppSecret(
  id: number
): Promise<RotatedSecret> {
  const res = await apiFetch(`/api/developer/apps/${id}/rotate-secret`, {
    method: "POST",
    preserve401: true,
  });
  return res.json();
}

export async function revokeDeveloperApp(id: number): Promise<void> {
  await apiFetch(`/api/developer/apps/${id}`, {
    method: "DELETE",
    preserve401: true,
  });
}
