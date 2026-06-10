import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetchJson } from "./client";

export type ErrorSource = "client" | "server";
export type ErrorSeverity = "error" | "warn" | "info";

export type ErrorLogRow = {
  id: number;
  source: ErrorSource;
  user_id: number | null;
  user_email: string | null;
  session_id: string | null;
  severity: ErrorSeverity;
  message: string;
  stack: string | null;
  url: string | null;
  user_agent: string | null;
  request_id: string | null;
  status_code: number | null;
  method: string | null;
  extra: unknown;
  created_at: string;
};

export type ErrorLogStats = {
  errors_1h: number;
  errors_24h: number;
  client_24h: number;
  server_24h: number;
  users_24h: number;
};

export type ErrorLogListResponse = {
  logs: ErrorLogRow[];
  stats: ErrorLogStats;
};

export type ErrorLogFilters = {
  source?: ErrorSource;
  severity?: ErrorSeverity;
  q?: string;
  limit?: number;
};

export const listErrorLogs = (filters: ErrorLogFilters = {}) => {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.q) params.set("q", filters.q);
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return apiFetchJson<ErrorLogListResponse>(
    `/api/platform/error-logs${qs ? `?${qs}` : ""}`
  );
};

// ── Ingest side ──────────────────────────────────────────────────────
// Called by window error handlers and the apiFetch wrapper. Uses raw
// fetch (not apiFetch) to avoid recursion when a 5xx triggers another
// reporting call — and to keep the post fire-and-forget when the user
// is logged out or has a bad token.

export type ClientErrorReport = {
  message: string;
  severity?: ErrorSeverity;
  stack?: string;
  url?: string;
  user_agent?: string;
  session_id?: string;
  request_id?: string;
  status_code?: number;
  method?: string;
  extra?: unknown;
};

let reportSessionId: string | null = null;
function sessionId(): string {
  if (reportSessionId) return reportSessionId;
  try {
    const stored = sessionStorage.getItem("rwayve.errorlog.session");
    if (stored) {
      reportSessionId = stored;
      return stored;
    }
    const fresh = `s_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    sessionStorage.setItem("rwayve.errorlog.session", fresh);
    reportSessionId = fresh;
    return fresh;
  } catch {
    if (!reportSessionId)
      reportSessionId = `s_${Math.random().toString(36).slice(2)}`;
    return reportSessionId;
  }
}

// Throttle identical messages so a tight error loop doesn't flood the
// table. Key by message + status_code; one report per 5 seconds per key.
const recentReports = new Map<string, number>();
const THROTTLE_MS = 5_000;

export function reportClientError(report: ClientErrorReport): void {
  if (!report.message) return;
  const key = `${report.message}|${report.status_code ?? ""}`;
  const last = recentReports.get(key) ?? 0;
  const now = Date.now();
  if (now - last < THROTTLE_MS) return;
  recentReports.set(key, now);

  const body: ClientErrorReport = {
    severity: "error",
    url: typeof window !== "undefined" ? window.location.href : undefined,
    user_agent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    session_id: sessionId(),
    ...report,
  };

  const token = getAuthToken();
  // Fire-and-forget. We deliberately swallow any error here: if logging
  // itself is broken, falling into a console.error is enough — anything
  // louder would mask the original problem the user just hit.
  void fetch(`${getApiBase()}/api/error-logs`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch((err) => {
    // Last-ditch console log only — don't recurse into reportClientError.
    if (typeof console !== "undefined") {
      console.warn("[error-log] failed to send report", err);
    }
  });
}
