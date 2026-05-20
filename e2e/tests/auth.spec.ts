import { test, expect, type Page } from "@playwright/test";

// Auth golden-path E2E. These tests drive a real browser against the running
// stack, so they exercise the integration glue that unit + integration tests
// can't reach: form → network → backend → JWT → cookie/storage → protected
// route guard → redirect. A regression in any one of those links fails here.
//
// Each test creates a fresh user (uuid-suffixed email) so reruns don't trip
// the duplicate-email branch. We do NOT clean up users — the backend test DB
// is wiped between CI jobs, and locally the noise is tolerable.

function freshEmail(prefix: string): string {
  // crypto.randomUUID is available in Node 20+ and in the browser context.
  return `e2e-${prefix}-${crypto.randomUUID()}@example.test`;
}

async function registerUser(
  page: Page,
  email: string,
  password = "password123",
): Promise<void> {
  await page.goto("/register");
  await page.getByPlaceholder("Email").fill(email);
  // Two fields share the placeholder "Password"; the first is the password
  // input, the second the confirmation. getByPlaceholder().first()/nth(1)
  // is brittle but matches the actual DOM order in [Register.tsx](frontend/src/auth/Register.tsx).
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByPlaceholder("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
}

async function loginUser(
  page: Page,
  email: string,
  password = "password123",
): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

test.describe("authentication", () => {
  test("register issues a token and lands the user on their home", async ({
    page,
  }) => {
    const email = freshEmail("register");
    await registerUser(page, email);

    // Personal accounts route to /home; the assertion is on URL, not page
    // content, so it survives copy changes.
    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  });

  test("login with valid credentials reaches a protected route", async ({
    page,
  }) => {
    const email = freshEmail("login-ok");
    await registerUser(page, email);
    await expect(page).toHaveURL(/\/home$/);

    // Log out by clearing storage + reload — a deterministic way to drop the
    // session without depending on a "Logout" button living in a particular
    // place. Then assert the protected route bounces back to /login.
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.context().clearCookies();

    await page.goto("/home");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // Log back in — full credential path.
    await loginUser(page, email);
    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  });

  test("login with wrong password keeps the user on /login", async ({
    page,
  }) => {
    const email = freshEmail("wrong-pw");
    await registerUser(page, email);
    await expect(page).toHaveURL(/\/home$/);

    // Drop the session so the login form actually attempts the request
    // (logged-in users skip /login entirely).
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.context().clearCookies();

    await loginUser(page, email, "definitely-wrong");

    // Stays on /login — the backend returned 401, the SPA surfaces an error,
    // no redirect happens.
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated visit to a protected route redirects to /login", async ({
    page,
  }) => {
    // No session at all — going straight to /chat must bounce to /login,
    // which is the ProtectedRoute contract in App.tsx.
    await page.goto("/chat");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("register rejects mismatched password confirmation client-side", async ({
    page,
  }) => {
    await page.goto("/register");
    await page.getByPlaceholder("Email").fill(freshEmail("mismatch"));
    await page.getByPlaceholder("Password", { exact: true }).fill("password123");
    await page.getByPlaceholder("Confirm Password").fill("password999");
    await page.getByRole("button", { name: "Register", exact: true }).click();

    // The validation is local — there should be no navigation away from
    // /register, and the error text appears in the form.
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByText(/do not match/i)).toBeVisible();
  });
});
