import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhook, listEventCatalog, testWebhook } from "../../api/webhooks";
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

describe("api/webhooks", () => {
  beforeEach(() => {
    setAuthToken("test-jwt");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthToken();
  });

  describe("listEventCatalog", () => {
    it("GETs /api/webhooks/events and returns the frozen catalog", async () => {
      const catalog = {
        events: [
          "task.created",
          "task.updated",
          "task.deleted",
          "meeting.created",
          "meeting.updated",
          "meeting.deleted",
          "email.received",
          "email.sent",
          "chat.message.sent",
          "chat.channel.created",
          "wayve.ping",
        ],
        api_version: "2026.05",
      };
      const fetchMock = mockFetch(200, catalog);

      const result = await listEventCatalog();

      expect(result.api_version).toBe("2026.05");
      // The catalog is a long-term contract. If a new event sneaks in
      // without updating both backend AND this test, that's the brittleness
      // we want: the addition should be deliberate.
      expect(result.events).toHaveLength(11);
      expect(result.events).toContain("task.created");
      expect(result.events).toContain("chat.message.sent");
      expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/webhooks/events`);
    });
  });

  describe("createWebhook", () => {
    it("POSTs /api/webhooks with url + events + org_wide flag", async () => {
      const created = {
        id: 1,
        url: "https://example.com/hook",
        description: "CRM",
        events: ["task.created"],
        enabled: true,
        org_wide: false,
        organization_id: null,
        secret: "whsec_revealed_once",
        secret_preview: "whsec_revea…ce",
        consecutive_failures: 0,
        last_success_at: null,
        last_failure_at: null,
        created_at: "2026-05-24T13:30:00Z",
      };
      const fetchMock = mockFetch(200, created);

      const result = await createWebhook({
        url: "https://example.com/hook",
        events: ["task.created"],
        description: "CRM",
        org_wide: false,
      });

      expect(result.secret).toBe("whsec_revealed_once");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/webhooks`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        url: "https://example.com/hook",
        events: ["task.created"],
        description: "CRM",
        org_wide: false,
      });
    });
  });

  describe("testWebhook", () => {
    it("POSTs /api/webhooks/{id}/test with no body", async () => {
      const fetchMock = mockFetch(200, { queued: true });

      const result = await testWebhook(42);

      expect(result.queued).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API_BASE}/api/webhooks/42/test`);
      expect(init.method).toBe("POST");
    });
  });
});
