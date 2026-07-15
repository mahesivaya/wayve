import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { clearAuthToken, setAuthToken } from "../../auth/token";
import {
  clearHomeCache,
  loadCached,
  saveCached,
} from "../../home/dashboard/useCardData";

// HS256 JWT for { sub: 99, email: alice@example.com, exp: 9999999999 }.
const VALID_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOjk5LCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ." +
  "Yfk2GANHfoqcl3T1jbBhHptPj0xK_e3pGE9pq5VtZ8I";

// A snapshot of the shape that actually leaked: real inbox subjects and senders.
const SEED_EMAILS = [
  {
    id: 1,
    subject: "Q3 board deck",
    sender: "cfo@example.com",
    is_read: false,
  },
];

// Enumerate through the Storage API, not Object.keys — the jsdom polyfill in
// test/setup.ts is a class wrapping a Map, so Object.keys would report its
// private field instead of the stored keys.
const homeKeys = (): string[] => {
  const found: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key?.startsWith("rwayve.home.")) found.push(key);
  }
  return found;
};

describe("home cache is purged when the session ends", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 99, email: "alice@example.com" }),
      } as unknown as Response)
    );
  });

  afterEach(() => {
    clearAuthToken();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("drops every rwayve.home.* key and leaves unrelated keys alone", () => {
    saveCached("personal.emails", SEED_EMAILS);
    saveCached("today", { events: [] });
    // PersonalDashboard writes this one directly, outside saveCached — the sweep
    // is by prefix precisely so it is covered too.
    sessionStorage.setItem("rwayve.home.recentlyRead", "[1,2,3]");
    sessionStorage.setItem("wayve-logout-reason", "idle");

    clearHomeCache();

    expect(loadCached("personal.emails")).toBeNull();
    expect(loadCached("today")).toBeNull();
    expect(sessionStorage.getItem("rwayve.home.recentlyRead")).toBeNull();
    // Not ours: must survive, or the idle-logout notice on /login breaks.
    expect(sessionStorage.getItem("wayve-logout-reason")).toBe("idle");
  });

  it("purges the cached inbox on session expiry, so the next user can't read it", async () => {
    saveCached("personal.emails", SEED_EMAILS);
    setAuthToken(VALID_JWT);

    render(
      <MemoryRouter>
        <AuthProvider>
          <div />
        </AuthProvider>
      </MemoryRouter>
    );

    // The API client fires this on any 401 rather than hard-reloading.
    window.dispatchEvent(new Event("rwayve:session-expired"));

    await waitFor(() => {
      expect(loadCached("personal.emails")).toBeNull();
    });
    // The raw key is gone, not merely unreadable through loadCached.
    expect(homeKeys()).toEqual([]);
  });
});
