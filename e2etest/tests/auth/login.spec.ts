import { test, expect } from "@playwright/test";
import { loginViaUI } from "../../fixtures/auth-actions";
import { registerUser } from "../../fixtures/user";

// Login happy path + the most common failure mode (wrong password).
// Skips OAuth (Gmail/Outlook/Yahoo) — those need a real OAuth dance
// that this suite isn't wired for.

test.describe("login", () => {
  test("seeded user can log in", async ({ page }) => {
    const user = await registerUser();

    await loginViaUI(page, user.email, user.password);

    // After login the user lands on an authenticated route (the exact
    // path varies by account_type). The Layout's primary navigation
    // sidebar (`aria-label="Primary navigation"`) is the universal
    // "you're inside the app" signal — present for every auth scope.
    await expect(
      page.getByRole("navigation", { name: /primary navigation/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("wrong password is rejected", async ({ page }) => {
    const user = await registerUser();

    await loginViaUI(page, user.email, "definitely-not-the-real-password");

    // The page should NOT navigate to /home. It either stays on /login
    // with an error or surfaces the generic "invalid credentials" copy.
    // Allow ~3s for the form's busy state to resolve.
    await page.waitForTimeout(3_000);
    await expect(page).toHaveURL(/\/login/);
  });
});
