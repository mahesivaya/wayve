import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `loadRuntimeConfig` caches in a module-level variable; `vi.resetModules()`
// gives each test a fresh module (and thus a fresh cache).
describe("loadRuntimeConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses /api/config and caches the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        api_base: "https://api.example.com",
        ws_base: "wss://api.example.com",
        stripe_publishable_key: "pk_test_123",
        environment: "production",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadRuntimeConfig, runtimeConfig } = await import(
      "../config/runtimeConfig"
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg.apiBase).toBe("https://api.example.com");
    expect(cfg.wsBase).toBe("wss://api.example.com");
    expect(cfg.stripePublishableKey).toBe("pk_test_123");
    expect(cfg.environment).toBe("production");
    expect(runtimeConfig()).toEqual(cfg);

    // Second call is served from cache — no extra request.
    await loadRuntimeConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to empty defaults when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const { loadRuntimeConfig } = await import("../config/runtimeConfig");
    const cfg = await loadRuntimeConfig();
    expect(cfg.apiBase).toBe("");
    expect(cfg.wsBase).toBe("");
    expect(cfg.stripePublishableKey).toBeNull();
  });

  it("falls back when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { loadRuntimeConfig } = await import("../config/runtimeConfig");
    const cfg = await loadRuntimeConfig();
    expect(cfg.apiBase).toBe("");
    expect(cfg.environment).toBe("unknown");
  });
});
