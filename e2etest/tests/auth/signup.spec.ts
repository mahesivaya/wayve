import { test, expect } from "@playwright/test";
import { signupViaUI } from "../../fixtures/auth-actions";
import { uniqueEmail } from "../../fixtures/user";

// Local-credential signup. Driven through the actual UI rather than
// the API so we catch form regressions (label association, button
// states, redirects).

test.describe("signup", () => {
  test("new email + strong password lands the user inside the app", async ({ page }) => {
    const email = uniqueEmail("e2e-signup");
    const password = "E2eTest_2026!Strong";

    await signupViaUI(page, email, password);

    // The Layout's primary navigation sidebar only mounts for
    // authenticated users — its appearance is the universal "we're
    // past the public marketing surface" signal, regardless of
    // account type or which dashboard the user lands on.
    await expect(
      page.getByRole("navigation", { name: /primary navigation/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
