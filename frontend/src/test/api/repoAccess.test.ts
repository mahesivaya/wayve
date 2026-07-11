import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRepoAccess,
  removeRepoAccess,
  setRepoAccess,
} from "../../api/repoAccess";
import { clearAuthToken, setAuthToken } from "../../auth/token";

const API_BASE = (import.meta.env.VITE_API_URL ?? "") as string;

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

describe("api/repoAccess", () => {
  beforeEach(() => setAuthToken("test-jwt"));
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthToken();
  });

  it("getRepoAccess GETs the encoded repo access path", async () => {
    const body = {
      repo: "acme/widgets",
      github_readable: true,
      can_manage: true,
      rows: [],
    };
    const fetchMock = mockFetch(200, body);
    const result = await getRepoAccess("acme", "widgets");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/repos/acme/widgets/access`);
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(result.can_manage).toBe(true);
  });

  it("setRepoAccess PUTs the login + level", async () => {
    const fetchMock = mockFetch(200, {
      dashboard_updated: false,
      github_outcome: "synced",
    });
    const res = await setRepoAccess("acme", "widgets", {
      github_login: "carol",
      level: "read",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/repos/acme/widgets/access`);
    const request = init as RequestInit;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body as string)).toEqual({
      github_login: "carol",
      level: "read",
    });
    expect(res.github_outcome).toBe("synced");
  });

  it("removeRepoAccess DELETEs with the user_id query param", async () => {
    const fetchMock = mockFetch(200, {
      dashboard_updated: true,
      github_outcome: "skipped",
    });
    await removeRepoAccess("acme", "widgets", { user_id: 42 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/repos/acme/widgets/access?user_id=42`);
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
