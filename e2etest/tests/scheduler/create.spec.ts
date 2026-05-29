import { test, expect } from "@playwright/test";
import { loginViaUI } from "../../fixtures/auth-actions";
import { registerUser } from "../../fixtures/user";

// /scheduler should at minimum render its main heading after login.
// Full create-a-meeting flow needs a date picker, time inputs, and a
// participant — left to a follow-up spec; this one just guarantees
// the page mounts.

test.describe("/scheduler", () => {
  test("authenticated user can open the scheduler", async ({ page }) => {
    const user = await registerUser();
    await loginViaUI(page, user.email, user.password);
    await page.waitForURL(/\/(home|organization-home)?(\?|$)/, { timeout: 15_000 });

    await page.goto("/scheduler");

    // The scheduler renders a heading containing "Scheduler" or
    // "Calendar" depending on locale/copy — accept either.
    await expect(
      page.getByText(/scheduler|calendar|meetings/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
