import { test, expect } from "@playwright/test";

// Public marketing home — the URL anyone reaches at the root before
// logging in. Cheapest possible smoke: the page renders, the wordmark
// is visible, the Login button leads to /login.

test.describe("public home", () => {
  test("renders the Wayve wordmark", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$|\/home$/);
    // Brand button uses the wordmark "Wayve" in the top-left nav.
    await expect(page.getByRole("button", { name: /^wayve$/i })).toBeVisible();
  });

  test("nav links to login + register pages", async ({ page }) => {
    await page.goto("/");
    // The Login affordance opens /login. Different headers/widths render
    // it as either a button or a link, so use a role-agnostic match.
    const loginCta = page.getByRole("button", { name: /^log\s?in$/i }).or(
      page.getByRole("link", { name: /^log\s?in$/i }),
    );
    await loginCta.first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
