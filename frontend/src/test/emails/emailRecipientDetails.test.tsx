// An open email's header reads like Gmail's: a short "to me ▾" line under the
// sender that opens a card with From, To, Cc and Date, each address whole.
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  downloadEmailAttachment: vi.fn().mockResolvedValue(undefined),
  getGmailConnectUrl: vi.fn().mockResolvedValue("https://accounts.test/oauth"),
  filesToAttachments: vi.fn().mockResolvedValue([]),
  searchContacts: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/sharedInboxes", () => ({
  updateEmailState: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@test.local" } }),
}));

import { EmailDetail } from "../../emails/EmailDetail";
import { summarizeRecipients } from "../../emails/recipientSummary";
import type { EmailItem } from "../../emails/types";

const email: EmailItem = {
  id: 42,
  account_id: 7,
  subject: "How to get high-resolution images",
  sender: "EOSDA LandViewer <support@eos.test>",
  receiver: "me@test.local",
  cc: "Bob Stone <bob@test.local>",
  body: "Hello!",
  created_at: "2026-11-08T17:04:00Z",
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("summarizeRecipients", () => {
  it("calls your own address 'me' and puts it first", () => {
    expect(summarizeRecipients("me@x.test", "", ["me@x.test"])).toBe("me");
    expect(
      summarizeRecipients("Ada Lovelace <ada@x.test>, ME@x.test", "", [
        "me@x.test",
      ])
    ).toBe("me, Ada");
  });

  it("uses the part before @ when there's no name, and counts the rest", () => {
    expect(
      summarizeRecipients("a@x.test, b@x.test", "c@x.test, d@x.test", [])
    ).toBe("a, b and 2 others");
    expect(summarizeRecipients("a@x.test, b@x.test, c@x.test", "", [])).toBe(
      "a, b and 1 other"
    );
  });

  it("is empty with no recipients", () => {
    expect(summarizeRecipients(null, null, [])).toBe("");
  });
});

describe("EmailDetail recipient details", () => {
  afterEach(cleanup);

  it("shows 'to me, Bob' and opens From / To / Cc / Date on click", async () => {
    render(
      <EmailDetail
        selectedEmail={email}
        viewMode="email"
        onBack={vi.fn()}
        onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await settle();

    const toggle = screen.getByRole("button", { name: /^to me, Bob/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".email-meta-details")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = document.querySelector(".email-meta-details");
    const labels = Array.from(
      details?.querySelectorAll("dt") ?? [],
      (dt) => dt.textContent
    );
    expect(labels).toEqual(["From", "To", "Cc", "Date"]);
    expect(details?.textContent).toContain("support@eos.test");
    expect(details?.textContent).toContain("me@test.local");
    expect(details?.textContent).toContain("Bob Stone <bob@test.local>");

    fireEvent.click(toggle);
    expect(document.querySelector(".email-meta-details")).toBeNull();
  });
});
