import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, invalidateGetCache } from "../../api/client";
import { clearAuthToken } from "../../auth/token";

// Real Response objects (not a fake) so clone()/json() stream semantics are
// genuinely exercised — the whole point of the coalescing/cache layer is that
// every caller gets an independently-readable body.
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api/client request layer", () => {
  beforeEach(() => {
    clearAuthToken();
    invalidateGetCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateGetCache();
  });

  it("coalesces concurrent identical GETs into one network request", async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);

    // Both started before the network resolves → must share one fetch.
    const p1 = apiFetch("/api/x");
    const p2 = apiFetch("/api/x");
    resolveFetch(jsonResponse({ ok: 1 }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Each awaiter gets its own readable body.
    await expect(r1.json()).resolves.toEqual({ ok: 1 });
    await expect(r2.json()).resolves.toEqual({ ok: 1 });
  });

  it("serves a cached GET within cacheTtlMs without refetching", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ n: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const a = await apiFetch("/api/y", { cacheTtlMs: 1000 });
    const b = await apiFetch("/api/y", { cacheTtlMs: 1000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(a.json()).resolves.toEqual({ n: 1 });
    await expect(b.json()).resolves.toEqual({ n: 1 });
  });

  it("does not cache GETs without cacheTtlMs", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ n: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/no-cache");
    await apiFetch("/api/no-cache");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the GET cache on any non-GET request", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ n: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/z", { cacheTtlMs: 1000 }); // 1: populates cache
    await apiFetch("/api/z", { method: "POST", body: "{}" }); // 2: mutation clears cache
    await apiFetch("/api/z", { cacheTtlMs: 1000 }); // 3: cache empty → refetch

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
