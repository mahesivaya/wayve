import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetchJson } from "./client";

const VISIT_SENT_KEY = "rwayve.visitBeaconSent";

// A fire-and-forget "page opened" beacon, guarded by sessionStorage so SPA
// navigations and re-renders cannot spam rows. It is safe anonymously: the
// bearer token is attached only when present, and the IP and user-agent are
// recorded server-side rather than sent by the client.
export function reportVisit(path: string, referrer: string): void {
  try {
    if (sessionStorage.getItem(VISIT_SENT_KEY)) return;
    sessionStorage.setItem(VISIT_SENT_KEY, "1");
  } catch {
    // sessionStorage is unavailable in private mode; still send the beacon.
  }

  const token = getAuthToken();
  void fetch(`${getApiBase()}/api/visits`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, referrer: referrer || undefined }),
    keepalive: true,
  }).catch(() => {
    // Best-effort: never disturb the page over a failed log.
  });
}

export type VisitRow = {
  id: number;
  user_id: number | null;
  user_email: string | null;
  ip: string | null;
  user_agent: string | null;
  path: string;
  referrer: string | null;
  created_at: string;
  // Coarse geolocation of `ip`, resolved offline at write time. Null for older
  // rows and private or unresolvable IPs.
  country: string | null;
  region: string | null;
  city: string | null;
};

export async function listVisits(
  filters: { limit?: number } = {}
): Promise<VisitRow[]> {
  const params = new URLSearchParams();
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return apiFetchJson<VisitRow[]>(
    `/api/platform/visits${query ? `?${query}` : ""}`,
    { preserve401: true }
  );
}
