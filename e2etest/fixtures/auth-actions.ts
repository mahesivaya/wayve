import type { Page } from "@playwright/test";

// Drives the login + register forms. The components use placeholder
// text rather than <label>, so we target by `getByPlaceholder`. If the
// markup is restyled to use real labels, swap these helpers — every
// spec calls through here, so no spec file needs to know.
//
// /login renders TWO inputs: one for SSO ("you@your-company.com") and one
// for password login ("Email or username"). The exact placeholder match
// disambiguates. (Register still uses "Email" — login accepts username too.)

export async function loginViaUI(page: Page, email: string, password: string) {
  await page.goto("/login");
  // The password-login field has placeholder="Email or username" (exact).
  await page.getByPlaceholder("Email or username", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^login$/i }).click();
}

export async function signupViaUI(
  page: Page,
  email: string,
  password: string,
) {
  await page.goto("/register");
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByPlaceholder("Confirm Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^register$/i }).click();
}
