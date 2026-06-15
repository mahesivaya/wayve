import { apiFetch, apiFetchJson } from "./client";

export type ActivityKind = "page_view" | "click";

// Fire-and-forget telemetry for the non-consequential activity stream. Never
// awaited and never surfaces an error — it must not disrupt the UI.
export function recordActivity(
  kind: ActivityKind,
  payload: { label?: string; path?: string }
): void {
  void apiFetch("/api/activity", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({ kind, ...payload }),
  }).catch(() => {
    /* telemetry is best-effort */
  });
}

export type ActivityEventRow = {
  id: number;
  kind: string;
  label: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  ip: string | null;
  created_at: string;
};

export type UserActivityResult = {
  user: { id: number; email: string };
  events: ActivityEventRow[];
};

// Per-user non-consequential activity (page views, clicks, API requests).
// Owner-gated server-side (org owner → their members only).
export async function lookupUserActivity(
  email: string
): Promise<UserActivityResult> {
  const params = new URLSearchParams({ email });
  return apiFetchJson<UserActivityResult>(
    `/api/audit/user-activity?${params.toString()}`,
    { preserve401: true }
  );
}
