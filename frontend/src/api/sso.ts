// SSO API client. Three surfaces:
//   1. Org-admin CRUD over /api/organizations/{id}/sso/config — gated by the
//      `sso:manage` permission on the backend.
//   2. A test-connection helper that re-uses the saved config to fetch the
//      IdP's discovery doc and returns the parsed endpoints.
//   3. An sso-start URL builder used by the public login screen. The actual
//      navigation is left to the caller (window.location.href) so a button
//      click feels like a real cross-origin redirect (it is one).
//
// The shape mirrors backend/src/routes/sso.rs::SsoConfigView. Keep both in
// sync if you add fields.

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
  // Optional on update: omit to keep the existing secret. Required on
  // first save (the backend enforces this).
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

/** Fetch the org's SSO config. Returns null when none is set yet (404). */
export async function getSsoConfig(orgId: number): Promise<SsoConfig | null> {
  const res = await apiFetch(`/organizations/${orgId}/sso/config`, {
    preserve401: true,
    // 404 = no SSO config set for this org yet; return null, don't throw.
    preserve404: true,
  });
  if (res.status === 404) return null;
  return (await res.json()) as SsoConfig;
}

/** Create or update the org's SSO config (PUT is upsert). */
export function saveSsoConfig(
  orgId: number,
  input: SsoConfigInput
): Promise<SsoConfig> {
  return apiFetchJson<SsoConfig>(`/organizations/${orgId}/sso/config`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Remove the org's SSO config. */
export async function deleteSsoConfig(orgId: number): Promise<void> {
  await apiFetch(`/organizations/${orgId}/sso/config`, { method: "DELETE" });
}

/** Test the connection — backend fetches the IdP's discovery doc. */
export function testSsoConfig(orgId: number): Promise<SsoTestResult> {
  return apiFetchJson<SsoTestResult>(`/organizations/${orgId}/sso/test`, {
    method: "POST",
  });
}

/**
 * Build the absolute URL the browser should navigate to in order to start
 * the SSO redirect dance. Returns null if `email` doesn't contain `@` (we
 * leave the form-validation to the caller, but a malformed email shouldn't
 * become a server round-trip).
 */
export function ssoStartUrl(email: string, returnTo?: string): string | null {
  const trimmed = email.trim();
  if (!trimmed.includes("@")) return null;
  const params = new URLSearchParams({ email: trimmed });
  if (returnTo) params.set("return_to", returnTo);
  return `${getApiBase()}/auth/sso/start?${params.toString()}`;
}
