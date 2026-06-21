import { apiFetch, apiFetchJson } from "./client";

// Per-user GitLab connection state. Mirrors the backend `ConnectionStatus`; the
// access token is never returned.
export type GitlabConnectionStatus = {
  connected: boolean;
  base_url: string | null;
  enabled: boolean;
};

export const getGitlabConnection = async () =>
  apiFetchJson<GitlabConnectionStatus>("/api/integrations/gitlab/connection");

export const connectGitlab = async (payload: {
  base_url?: string;
  access_token: string;
}) =>
  apiFetchJson<GitlabConnectionStatus>("/api/integrations/gitlab/connection", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const disconnectGitlab = async () => {
  await apiFetch("/api/integrations/gitlab/connection", { method: "DELETE" });
};

export type GitlabImportResult = { imported: number; updated: number };

// Pull issues assigned to the connected user into their tasks.
export const importGitlabIssues = async (payload?: {
  state?: "opened" | "closed" | "all";
  max_results?: number;
}) =>
  apiFetchJson<GitlabImportResult>("/api/integrations/gitlab/import", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
