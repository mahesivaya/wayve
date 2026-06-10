import { apiFetch, apiFetchJson } from "./client";

export type ScimToken = {
  id: number;
  organization_id: number;
  organization_name: string | null;
  name: string;
  token_preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
};

export type ScimTokenCreated = {
  id: number;
  organization_id: number;
  name: string;
  token: string;
  token_preview: string;
  scim_endpoint: string;
};

export const listScimTokens = () =>
  apiFetchJson<ScimToken[]>("/api/scim/tokens");

export const createScimToken = (input: {
  name: string;
  organization_id: number;
}) =>
  apiFetchJson<ScimTokenCreated>("/api/scim/tokens", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const revokeScimToken = (id: number) =>
  apiFetch(`/api/scim/tokens/${id}`, { method: "DELETE" });
