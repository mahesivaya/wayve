// @vitest-environment node
//
// Guards the predicate that decides whether the email detail view shows the
// "Reconnect Gmail" button. The backend body endpoint returns a 409 with one
// of the "needs to be reconnected" messages when an account's refresh token is
// dead; isGmailReconnectError must recognise those (and only those) so the
// button appears exactly when reconnecting is the actual fix.

import { describe, it, expect } from "vitest";
import { isGmailReconnectError } from "../../emails/bodyUtils";

describe("isGmailReconnectError", () => {
  it("matches the backend's body-fetch reconnect messages", () => {
    expect(
      isGmailReconnectError(
        "This Gmail account needs to be reconnected to load this message."
      )
    ).toBe(true);
    expect(
      isGmailReconnectError(
        "This Gmail account needs to be reconnected before Fluxze can load message bodies."
      )
    ).toBe(true);
  });

  it("accepts an Error instance, not just a string", () => {
    expect(
      isGmailReconnectError(new Error("Reconnect your email account"))
    ).toBe(true);
  });

  it("does not match unrelated body errors", () => {
    expect(
      isGmailReconnectError(
        "Unable to decrypt this fully encrypted email on this device."
      )
    ).toBe(false);
    expect(isGmailReconnectError("Failed to load email body. Try again.")).toBe(
      false
    );
    expect(isGmailReconnectError(null)).toBe(false);
    expect(isGmailReconnectError(undefined)).toBe(false);
  });
});
