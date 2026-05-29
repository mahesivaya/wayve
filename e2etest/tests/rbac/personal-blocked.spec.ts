import { test, expect } from "@playwright/test";
import { apiGet } from "../../fixtures/api";
import { registerUser } from "../../fixtures/user";
import { resetRateLimits } from "../../fixtures/reset-rate-limits";

// Authorization smoke: a plain personal user must NOT be able to hit
// platform-scoped endpoints. RBAC is computed per-request (security/rbac.rs)
// and `account_type='personal'` should land us in the personal scope
// regardless of any stray JWT claims.
//
// Both endpoints share a single seeded user — registering twice in
// quick succession runs against the /api/register rate limit
// (5/300s), and the same token tests the same gate.

test.describe("RBAC: personal user blocked from platform endpoints", () => {
  test.beforeAll(async () => {
    await resetRateLimits();
  });

  test("platform_members + security_audit are forbidden", async ({ }) => {
    const user = await registerUser();
    const auth = { Authorization: `Bearer ${user.token}` };

    const platformMembers = await apiGet("/api/platform/members", auth);
    // 403 = Forbidden by RBAC, 404 = route only exists for platform
    // admin scope. Either is acceptable proof the personal user can't
    // see it.
    expect([403, 404]).toContain(platformMembers.status);

    const audit = await apiGet("/api/security/audit", auth);
    expect([403, 404]).toContain(audit.status);
  });
});
