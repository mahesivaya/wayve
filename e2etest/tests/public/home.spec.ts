import { test, expect } from "@playwright/test";

// Public marketing home — the URL anyone reaches at the root before
// logging in. Cheapest possible smoke: the page renders, the wordmark
// is visible, the Login button leads to /login.

test.describe("public home", () => {
  test("renders the Fluxze wordmark", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$|\/home$/);
    // The top-left brand button (logo + wordmark). Target it by class — its
    // accessible name isn't exactly "Fluxze" because the BrandLogo svg also
    // contributes to the name — and assert the wordmark text is present.
    const brand = page.locator("button.public-home-brand");
    await expect(brand).toBeVisible();
    await expect(brand).toContainText(/fluxze/i);
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
