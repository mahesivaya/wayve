import { describe, it, expect } from "vitest";
import { API_SCOPES, scopesFor } from "../api/apiKeys";

// The frontend scope catalog must stay in lockstep with the backend
// (backend/src/security/api_key.rs::API_SCOPES).
describe("API_SCOPES catalog", () => {
  it("mirrors the backend scope catalog", () => {
    expect([...API_SCOPES]).toEqual([
      "email:read",
      "email:send",
      "chat:read",
      "chat:write",
      "call:access",
      "scheduler:read",
      "scheduler:write",
      "drive:read",
      "drive:write",
      "notes:read",
      "notes:write",
      "tasks:read",
      "tasks:write",
      "ai:use",
      "profile:read",
      "admin",
    ]);
  });

  it("has no duplicate scopes", () => {
    expect(new Set(API_SCOPES).size).toBe(API_SCOPES.length);
  });

  it("every scope is a resource:action pair or a bare keyword", () => {
    for (const scope of API_SCOPES) {
      expect(scope).toMatch(/^[a-z_]+(:[a-z_]+)?$/);
    }
  });
});

// `admin` opens every management surface, so only an internal key may hold it.
describe("scopesFor", () => {
  it("offers admin to internal keys only", () => {
    expect(scopesFor("internal")).toContain("admin");
    expect(scopesFor("external")).not.toContain("admin");
  });

  it("leaves every other scope available to external keys", () => {
    expect(scopesFor("external")).toEqual(
      API_SCOPES.filter((scope) => scope !== "admin")
    );
  });
});
