import { apiFetch } from "./client";

// API key management calls. `apiFetch` throws an Error (carrying the backend
// `message`) on any non-2xx response, so these helpers only parse the body.
//
// The scope catalog mirrors backend/src/security/api_key.rs::API_SCOPES.
export const API_SCOPES = [
  "email:read",
  "email:send",
  "chat:read",
  "chat:write",
  "call:access",
  "scheduler:read",
  "scheduler:write",
  "drive:read",
  "drive:write",
  "notes:read",
  "notes:write",
  "tasks:read",
  "tasks:write",
  "ai:use",
  "profile:read",
  "admin",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

// Scopes only an internal key may hold (the backend also reserves "*"):
// `admin` opens every management surface, so a key handed to a third party
// cannot have it. Mirrors INTERNAL_ONLY_SCOPES in api_key.rs; the server
// refuses it regardless of what this list says.
export const INTERNAL_ONLY_SCOPES: readonly string[] = ["admin"];

// The scopes a key of this type may be given.
export const scopesFor = (keyType: "internal" | "external"): ApiScope[] =>
  API_SCOPES.filter(
    (scope) => keyType === "internal" || !INTERNAL_ONLY_SCOPES.includes(scope)
  );
export type KeyType = "internal" | "external";

export type ApiKey = {
  id: number;
  name: string;
  key_type: KeyType;
  scopes: string[];
  key_preview: string;
  user_id: number | null;
  organization_id: number | null;
  rate_limit_per_min: number;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

// The create response additionally carries the raw key — shown exactly once.
export type CreatedApiKey = ApiKey & { api_key: string };

export type ApiKeyAuditRow = {
  id: number;
  api_key_id: number | null;
  method: string;
  path: string;
  status_code: number;
  outcome: string;
  ip: string | null;
  created_at: string;
};

export type CreateApiKeyInput = {
  name: string;
  key_type: KeyType;
  scopes: string[];
  expires_at?: string | null;
  rate_limit_per_min?: number;
};

export async function createApiKey(
  input: CreateApiKeyInput
): Promise<CreatedApiKey> {
  const res = await apiFetch("/api/keys", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch("/api/keys", { preserve401: true });
  return res.json();
}

export async function revokeApiKey(id: number): Promise<void> {
  await apiFetch(`/api/keys/${id}`, { method: "DELETE", preserve401: true });
}

export async function getApiKeyAudit(id: number): Promise<ApiKeyAuditRow[]> {
  const res = await apiFetch(`/api/keys/${id}/audit`, { preserve401: true });
  return res.json();
}
