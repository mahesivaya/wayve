import { test, expect } from "@playwright/test";

// /pricing renders two variants:
//   - Anonymous visitors: PublicPricing component with marketing
//     tiers (Basic / Advanced / Organization / Enterprise).
//   - Signed-in non-personal users: dynamic catalog from /api/plans.
//   - Signed-in personal users: redirected to /settings (per
//     RedirectIfPersonal in App.tsx).
//
// We test the anonymous variant — it's the surface a prospect would
// first see and the redirect-for-personal makes the authed flow more
// expensive to seed.

test.describe("/pricing public", () => {
  test("anonymous visitor sees plan tiers + h1", async ({ page }) => {
    await page.goto("/pricing");

    await expect(
      page.getByRole("heading", { level: 1, name: /plan/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The marketing tiers ("Basic", "Advance", "More Advance",
    // "Small organization", "Enterprise") should all be discoverable.
    // Spot-check the bookends (free + paid endpoints) so a tier
    // rename in the middle doesn't flake the assertion.
    await expect(page.getByRole("heading", { name: /basic/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /advance/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /enterprise/i }).first()).toBeVisible();
  });
});
