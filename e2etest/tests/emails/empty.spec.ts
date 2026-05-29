import { test, expect } from "@playwright/test";
import { loginViaUI } from "../../fixtures/auth-actions";
import { registerUser } from "../../fixtures/user";

// A fresh user has no email accounts connected — the Emails route
// should render its empty state and the "+" button for adding the
// first inbox should be discoverable.

test.describe("/emails empty state", () => {
  test("fresh user sees Accounts section + add affordance", async ({ page }) => {
    const user = await registerUser();
    await loginViaUI(page, user.email, user.password);
    await page.waitForURL(/\/(home|organization-home)?(\?|$)/, { timeout: 15_000 });

    await page.goto("/emails");

    // The sidebar surfaces the "Accounts" label even when empty —
    // the "+" button next to it triggers the provider picker modal.
    await expect(page.getByText(/accounts/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /add account/i })).toBeVisible();
  });
});
