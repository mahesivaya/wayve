// SSO API client. The config CRUD is gated on the backend by the `sso:manage`
// permission, and the shapes here mirror backend/src/routes/sso.rs::SsoConfigView
// — keep the two in sync when adding fields.

import { apiFetchJson, apiFetch } from "./client";
import { getApiBase } from "../config/env";

export interface SsoConfig {
  id: number;
  organization_id: number;
  issuer_url: string;
  client_id: string;
  allowed_domain: string;
  enforce_sso: boolean;
  enabled: boolean;
  redirect_uri: string;
  created_at: string;
  updated_at: string;
}

export interface SsoConfigInput {
  issuer_url: string;
  client_id: string;
  // Omit on update to keep the existing secret. Required on first save, which
  // the backend enforces.
  client_secret?: string;
  allowed_domain: string;
  enforce_sso: boolean;
  enabled: boolean;
}

export interface SsoTestResult {
  ok: boolean;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  redirect_uri: string;
}

// Returns null rather than throwing when the org has no SSO config yet.
export async function getSsoConfig(orgId: number): Promise<SsoConfig | null> {
  const res = await apiFetch(`/api/organizations/${orgId}/sso/config`, {
    preserve401: true,
    preserve404: true,
  });
  if (res.status === 404) return null;
  return (await res.json()) as SsoConfig;
}

// PUT is an upsert, so this both creates and updates.
export function saveSsoConfig(
  orgId: number,
  input: SsoConfigInput
): Promise<SsoConfig> {
  return apiFetchJson<SsoConfig>(`/api/organizations/${orgId}/sso/config`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteSsoConfig(orgId: number): Promise<void> {
  await apiFetch(`/api/organizations/${orgId}/sso/config`, {
    method: "DELETE",
  });
}

// Re-uses the saved config: the backend fetches the IdP's discovery doc and
// returns the parsed endpoints.
export function testSsoConfig(orgId: number): Promise<SsoTestResult> {
  return apiFetchJson<SsoTestResult>(`/api/organizations/${orgId}/sso/test`, {
    method: "POST",
  });
}

// Builds the URL that starts the SSO redirect; the caller performs the actual
// navigation. Returns null for an email without an `@`, so a malformed address
// never becomes a server round-trip — real validation stays with the caller.
export function ssoStartUrl(email: string, returnTo?: string): string | null {
  const trimmed = email.trim();
  if (!trimmed.includes("@")) return null;
  const params = new URLSearchParams({ email: trimmed });
  if (returnTo) params.set("return_to", returnTo);
  return `${getApiBase()}/api/auth/sso/start?${params.toString()}`;
}
