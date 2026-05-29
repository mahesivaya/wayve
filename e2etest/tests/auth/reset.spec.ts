import { test, expect } from "@playwright/test";
import { registerUser } from "../../fixtures/user";
import { apiPost } from "../../fixtures/api";
import { purgeAllEmail, waitForEmailTo } from "../../fixtures/mailhog";

// Forgot-password → reset flow. Verifies:
//   1. Forgot endpoint mails a token via MailHog
//   2. /reset-password accepts the token and a fresh password
//   3. The OLD password no longer works after reset
//
// Requires MailHog to be reachable at E2E_MAILHOG_API. If it isn't,
// the test will skip (clearer than a confusing fetch error).

test.describe("password reset", () => {
  test.beforeAll(async () => {
    try {
      await purgeAllEmail();
    } catch {
      test.skip(true, "MailHog not reachable — skipping reset suite");
    }
  });

  // The dev stack's backend/.env defaults SMTP_HOST to smtp.gmail.com so
  // local dev can send real mail when wired up. Without overriding that
  // to MailHog (`SMTP_HOST=mailhog SMTP_PORT=1025`), the forgot-password
  // mail is delivered to Gmail which silently drops @test.local emails
  // and MailHog stays empty. Skip the round-trip until SMTP is pointed
  // at MailHog for E2E runs. Same convention CLAUDE.md describes for
  // backend tests: MailHog-dependent tests skip themselves when the
  // catch-all isn't actually receiving.
  test("full forgot → email → reset → login round-trip", async ({ page }) => {
    const user = await registerUser();

    // Trigger the reset.
    const forgot = await apiPost("/api/forgot-password", { email: user.email });
    expect(forgot.status).toBe(200);

    // MailHog should have a message addressed to this user. If not, the
    // backend's SMTP host probably isn't pointing at MailHog — skip
    // gracefully so the suite still reports the full picture.
    let body: string;
    try {
      body = await waitForEmailTo(user.email, { timeoutMs: 4_000 });
    } catch {
      test.skip(
        true,
        "Reset mail not delivered to MailHog — backend SMTP probably points at smtp.gmail.com. " +
          "To exercise this test, set SMTP_HOST=mailhog SMTP_PORT=1025 on the backend container.",
      );
      return;
    }
    const tokenMatch = body.match(/token=([A-Za-z0-9_-]+)/);
    expect(tokenMatch, `Expected reset token in email body: ${body.slice(0, 200)}`).not.toBeNull();
    const token = tokenMatch![1];

    // Use the token to change the password via the JSON endpoint.
    const newPassword = "E2eTest_2026!Rotated";
    const reset = await apiPost("/api/reset-password", {
      token,
      new_password: newPassword,
    });
    expect(reset.status).toBe(200);

    // Sanity: the old password is dead.
    const oldLogin = await apiPost("/api/login", {
      email: user.email,
      password: user.password,
    });
    expect(oldLogin.status).not.toBe(200);

    // The new password works.
    const newLogin = await apiPost<{ token: string }>("/api/login", {
      email: user.email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.token?.length).toBeGreaterThan(20);
  });
});
