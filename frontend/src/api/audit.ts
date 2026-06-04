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

// Actions that are a financial / billing signal (plan changes, entitlement
// grants, payment-method updates, cancellations).
const BILLING_ACTIONS = new Set([
  "checkout_started",
  "subscription_activated",
  "subscription_updated",
  "subscription_canceled",
  "subscription_cancel",
  "entitlement_grant",
  "entitlement_revoke",
  "payment_method_set",
]);

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

// Readable one-liner for a billing action's metadata.
function formatBillingDetails(row: UserActionRow): string {
  const m = row.metadata ?? {};
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : undefined);
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : undefined);
  const parts: string[] = [];
  switch (row.action) {
    case "entitlement_grant":
    case "entitlement_revoke": {
      const plan = str("plan_code") ?? row.resource_id ?? "free";
      const prev = str("previous_plan_code");
      parts.push(prev && prev !== plan ? `${prev} → ${plan}` : plan);
      const storage = num("storage_limit_bytes");
      if (storage != null) parts.push(`${fmtBytes(storage)} storage`);
      const seats = num("seat_limit");
      if (seats != null) parts.push(`${seats} seat${seats === 1 ? "" : "s"}`);
      break;
    }
    case "subscription_activated":
    case "subscription_updated":
    case "subscription_canceled": {
      const status = str("status");
      if (status) parts.push(status);
      if (m.cancel_at_period_end === true) parts.push("cancels at period end");
      break;
    }
    case "payment_method_set":
      parts.push(`pm ${row.resource_id ?? "updated"}`);
      break;
    case "checkout_started":
      parts.push(`plan ${row.resource_id ?? "?"}`);
      if (str("flow")) parts.push(`${str("flow")} flow`);
      break;
  }
  return parts.join(" · ");
}

// Human-readable summary of a user action's metadata for the "Details"
// column. Email events get a "from → to · subject" line; billing events get a
// plan/status summary; anything else falls back to compact key=value pairs (or
// "" when there's no metadata).
export function formatUserActionDetails(row: UserActionRow): string {
  const m = row.metadata;
  if (!m || typeof m !== "object") return "";
  if (row.action === "email_sent" || row.action === "email_received") {
    const from = typeof m.from === "string" ? m.from : "?";
    const to = typeof m.to === "string" ? m.to : "?";
    const subject = typeof m.subject === "string" ? m.subject : "(no subject)";
    return `${from} → ${to} · ${subject}`;
  }
  if (row.action === "role_change") {
    const from = typeof m.from_role === "string" ? m.from_role : "?";
    const to = typeof m.to_role === "string" ? m.to_role : "?";
    const target = m.target_user_id != null ? `user#${m.target_user_id}` : "user";
    const scope = typeof m.scope === "string" ? ` (${m.scope})` : "";
    return `${target}: ${from} → ${to}${scope}`;
  }
  if (BILLING_ACTIONS.has(row.action)) {
    const details = formatBillingDetails(row);
    if (details) return details;
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
