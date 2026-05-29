import { API_BASE } from "./env";

// Tiny `fetch` wrapper that targets the backend directly. Used for
// suite-level setup (seeding users, hitting the JSON API). Frontend
// flows that exercise the UI go through Playwright's page object
// instead — this is for arrange/assert, not for what we're testing.
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  // Try JSON, fall back to text so we can still surface error bodies.
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

export async function apiPost<T = unknown>(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(payload),
    headers,
  });
}

export async function apiGet<T = unknown>(path: string, headers: Record<string, string> = {}) {
  return apiFetch<T>(path, { method: "GET", headers });
}
