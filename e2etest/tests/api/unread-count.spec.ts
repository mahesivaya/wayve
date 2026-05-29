import { test, expect } from "@playwright/test";
import { apiGet } from "../../fixtures/api";
import { registerUser } from "../../fixtures/user";

// /api/emails/unread-count is the new partial-index-backed endpoint
// that powers the sidebar badge. A fresh user has no email accounts
// and therefore no unread email; the endpoint should return 0.

test.describe("/api/emails/unread-count", () => {
  test("returns { count: 0 } for a fresh user with no accounts", async ({ }) => {
    const user = await registerUser();
    const { status, body } = await apiGet<{ count: number }>(
      "/api/emails/unread-count",
      { Authorization: `Bearer ${user.token}` },
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });

  test("returns 401 without a session cookie", async ({ }) => {
    const { status } = await apiGet("/api/emails/unread-count");
    expect(status).toBe(401);
  });
});
