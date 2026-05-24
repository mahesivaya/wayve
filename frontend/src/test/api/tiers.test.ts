import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuota, listTiers } from "../../api/tiers";
import { clearAuthToken, setAuthToken } from "../../auth/token";

const API_BASE = (import.meta.env.VITE_API_URL ?? "") as string;

// Minimal `fetch` mock that returns the given JSON body with the given
// status. Mirrors the Auth.test.ts pattern so the two suites read the same.
function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this;
    },
  };
  const fn = vi.fn().mockResolvedValue(response as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api/tiers", () => {
  beforeEach(() => {
    clearAuthToken();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthToken();
  });

  describe("listTiers", () => {
    it("GETs /api/billing/tiers WITHOUT an Authorization header (public)", async () => {
      const tiers = [
        {
          code: "basic_user",
          name: "Basic User",
          audience: "personal",
          amount_cents: 0,
          currency: "usd",
          billing_interval: "month",
          rate_limit_per_min: 60,
          monthly_quota: 50000,
        },
      ];
      const fetchMock = mockFetch(200, tiers);

      const result = await listTiers();

      expect(result).toEqual(tiers);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/billing/tiers`);
      // The dashboard mounts this on /developers/quotas (public).
      // If the call ever silently starts requiring auth, the comparison
      // page breaks for logged-out visitors — guard the contract here.
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("getQuota", () => {
    it("GETs /api/billing/quota WITH Authorization when a token is present", async () => {
      setAuthToken("test-jwt");
      const quota = {
        plan_code: "advance_user",
        plan_name: "Advance User",
        rate_limit_per_min: 300,
        monthly_quota: 500_000,
        monthly_used: 42,
        monthly_remaining: 499_958,
        cycle_resets_at: "2026-06-01T00:00:00Z",
      };
      const fetchMock = mockFetch(200, quota);

      const result = await getQuota();

      expect(result).toEqual(quota);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/billing/quota`);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-jwt");
    });
  });
});
