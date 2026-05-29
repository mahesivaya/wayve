import { test, expect } from "@playwright/test";
import { apiGet, apiPost } from "../../fixtures/api";
import { registerUser } from "../../fixtures/user";

// Notes CRUD via the API surface (rather than driving the editor UI).
// Validates the most important contract: a freshly-created note shows
// up in the list for the same user, and is invisible to other users.

test.describe("notes API", () => {
  test("create + list a note for the owner", async ({ }) => {
    const user = await registerUser();
    const authHeader = { Authorization: `Bearer ${user.token}` };

    // GET /api/notes — should start empty for a new user.
    const initial = await apiGet<unknown[]>("/api/notes", authHeader);
    expect(initial.status).toBe(200);
    expect(Array.isArray(initial.body)).toBe(true);

    // Create a note. Field names mirror the backend handler.
    const created = await apiPost<{ id?: number }>(
      "/api/notes",
      { title: "E2E note", content: "hello from playwright" },
      authHeader,
    );
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    // Re-list. The new note id should appear.
    const after = await apiGet<Array<{ id: number }>>("/api/notes", authHeader);
    expect(after.status).toBe(200);
    expect((after.body as Array<{ id: number }>).length).toBeGreaterThan(
      (initial.body as unknown[]).length,
    );
  });

  test("another user does NOT see this user's notes", async ({ }) => {
    const userA = await registerUser();
    const userB = await registerUser();
    const aHeader = { Authorization: `Bearer ${userA.token}` };
    const bHeader = { Authorization: `Bearer ${userB.token}` };

    await apiPost(
      "/api/notes",
      { title: "alice-only", content: "secret" },
      aHeader,
    );

    const bobsNotes = await apiGet<Array<{ title: string }>>("/api/notes", bHeader);
    expect(bobsNotes.status).toBe(200);
    const titles = (bobsNotes.body as Array<{ title: string }>).map((n) => n.title);
    expect(titles).not.toContain("alice-only");
  });
});
