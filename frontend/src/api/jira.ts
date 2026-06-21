import { apiFetch, apiFetchJson } from "./client";

// Per-user Jira connection state. Mirrors the backend `ConnectionStatus`; the
// API token is never returned, so there is no token field here.
export type JiraConnectionStatus = {
  connected: boolean;
  base_url: string | null;
  email: string | null;
  enabled: boolean;
};

export const getJiraConnection = async () =>
  apiFetchJson<JiraConnectionStatus>("/api/integrations/jira/connection");

export const connectJira = async (payload: {
  base_url: string;
  email: string;
  api_token: string;
}) =>
  apiFetchJson<JiraConnectionStatus>("/api/integrations/jira/connection", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const disconnectJira = async () => {
  await apiFetch("/api/integrations/jira/connection", { method: "DELETE" });
};

export type JiraImportResult = { imported: number; updated: number };

// Pull issues into the caller's tasks. Defaults to "my open issues" server-side
// when no JQL is supplied.
export const importJiraIssues = async (payload?: {
  jql?: string;
  max_results?: number;
}) =>
  apiFetchJson<JiraImportResult>("/api/integrations/jira/import", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
