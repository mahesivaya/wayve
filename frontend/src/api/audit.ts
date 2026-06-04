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

export type UserActionRow = {
  id: number;
  actor_user_id: number | null;
  actor_email: string | null;
  organization_id: number | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  // Free-form event details (e.g. email from/to/subject for
  // email_sent / email_received).
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
};

// Human-readable summary of a user action's metadata for the "Details"
// column. Email events get a "from → to · subject" line; anything else falls
// back to compact key=value pairs (or "" when there's no metadata).
export function formatUserActionDetails(row: UserActionRow): string {
  const m = row.metadata;
  if (!m || typeof m !== "object") return "";
  if (row.action === "email_sent" || row.action === "email_received") {
    const from = typeof m.from === "string" ? m.from : "?";
    const to = typeof m.to === "string" ? m.to : "?";
    const subject = typeof m.subject === "string" ? m.subject : "(no subject)";
    return `${from} → ${to} · ${subject}`;
  }
  return Object.entries(m)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

export async function listUserActions(
  filters: { limit?: number; action?: string } = {},
): Promise<UserActionRow[]> {
  const params = new URLSearchParams();
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.action) params.set("action", filters.action);
  const query = params.toString();
  return apiFetchJson<UserActionRow[]>(
    `/api/audit/user-actions${query ? `?${query}` : ""}`,
    { preserve401: true },
  );
}

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

export async function downloadAuditExport(
  format: "jsonl" | "csv",
  since?: string,
): Promise<{ blob: Blob; nextCursor: string | null; count: number }> {
  const params = new URLSearchParams({ format, limit: "1000" });
  if (since) params.set("since", since);
  const res = await apiFetch(`/api/audit/export?${params.toString()}`, {
    preserve401: true,
  });
  return {
    blob: await res.blob(),
    nextCursor: res.headers.get("X-Audit-Next-Cursor"),
    count: Number(res.headers.get("X-Audit-Count") ?? 0),
  };
}

export async function testSiemSettings(): Promise<{ ok: boolean; status: number }> {
  const res = await apiFetch("/api/audit/siem-settings/test", {
    method: "POST",
    preserve401: true,
  });
  return res.json();
}
