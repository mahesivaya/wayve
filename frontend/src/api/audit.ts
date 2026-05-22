import { apiFetch, apiFetchJson } from "./client";

export type AuditLogRow = {
  id: number;
  api_key_id: number | null;
  api_key_name: string | null;
  key_preview: string | null;
  user_id: number | null;
  method: string;
  path: string;
  status_code: number;
  outcome: string;
  ip: string | null;
  created_at: string;
};

export type AuditLogFilters = {
  limit?: number;
  outcome?: string;
  api_key_id?: string;
  user_id?: string;
};

export type SiemSettings = {
  scope: string;
  organization_id: number | null;
  user_id: number | null;
  webhook_url: string;
  token_configured: boolean;
  enabled: boolean;
  source: string;
  updated_at: string | null;
};

export type SiemSettingsInput = {
  webhook_url: string;
  webhook_token?: string;
  enabled: boolean;
};

export async function listAuditLogs(filters: AuditLogFilters): Promise<AuditLogRow[]> {
  const params = new URLSearchParams();
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.api_key_id) params.set("api_key_id", filters.api_key_id);
  if (filters.user_id) params.set("user_id", filters.user_id);
  const query = params.toString();
  return apiFetchJson<AuditLogRow[]>(`/api/audit/logs${query ? `?${query}` : ""}`, {
    preserve401: true,
  });
}

export async function getSiemSettings(): Promise<SiemSettings> {
  return apiFetchJson<SiemSettings>("/api/audit/siem-settings", {
    preserve401: true,
  });
}

export async function saveSiemSettings(input: SiemSettingsInput): Promise<SiemSettings> {
  return apiFetchJson<SiemSettings>("/api/audit/siem-settings", {
    method: "PUT",
    preserve401: true,
    body: JSON.stringify(input),
  });
}

export async function testSiemSettings(): Promise<{ ok: boolean; status: number }> {
  const res = await apiFetch("/api/audit/siem-settings/test", {
    method: "POST",
    preserve401: true,
  });
  return res.json();
}
