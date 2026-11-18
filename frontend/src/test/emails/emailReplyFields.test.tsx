// The reply composer's recipient rows and Subject: seeded from the message,
// edited as chips, and what actually reaches sendEmail.
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

const sendEmail = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  sendEmail: (input: unknown) => sendEmail(input),
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
import type { EmailItem } from "../../emails/types";

const email: EmailItem = {
  id: 42,
  account_id: 7,
  subject: "Quarterly report",
  sender: "Ada Lovelace <ada@test.local>",
  receiver: "me@test.local",
  body: "Numbers attached.",
  created_at: "2026-07-01T12:00:00Z",
};

/** Opens the To/Cc/Bcc rows if the recipients are still the one-line summary. */
function openRecipients() {
  const summary = document.querySelector(".recipient-summary");
  if (summary) fireEvent.click(summary);
}

async function openReply(overrides: Partial<EmailItem> = {}) {
  render(
    <EmailDetail
      selectedEmail={{ ...email, ...overrides }}
      viewMode="email"
      onBack={vi.fn()}
      onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
    />
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.keyDown(document, { key: "r" });
  const summary = document.querySelector(".recipient-summary")?.textContent;
  openRecipients();
  return {
    summary,
    to: screen.getByLabelText("To") as HTMLInputElement,
    subject: screen.getByLabelText("Reply subject") as HTMLInputElement,
    body: screen.getByLabelText("Reply body") as HTMLTextAreaElement,
  };
}

/** Types an address into a chip field and commits it with Enter. */
function addChip(field: HTMLInputElement, address: string) {
  fireEvent.change(field, { target: { value: address } });
  fireEvent.keyDown(field, { key: "Enter" });
}

/**
 * The addresses currently chipped in one row. Scoped to the row rather than
 * the whole document because the message header above the composer shows the
 * sender's name and address too.
 */
function chips(field: HTMLInputElement): string[] {
  const row = field.closest(".recipient-field");
  return Array.from(row?.querySelectorAll(".recipient-chip") ?? []).map(
    (el) => el.firstChild?.textContent?.trim() ?? ""
  );
}

const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

describe("reply composer recipients and subject", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  it("seeds a To chip with the sender's address, without the display name", async () => {
    const { to } = await openReply();
    expect(chips(to)).toEqual(["ada@test.local"]);
  });

  it("defaults the subject to the thread's, prefixed with Re:", async () => {
    const { subject } = await openReply();
    expect(subject.value).toBe("Re: Quarterly report");
  });

  it("does not stack a second Re: on a subject that already has one", async () => {
    const { subject } = await openReply({
      subject: "Re: Request to schedule call",
    });
    expect(subject.value).toBe("Re: Request to schedule call");
  });

  it("replies to the recipients of your own message, not to you", async () => {
    // The newest message of a conversation is often your own reply.
    const { to } = await openReply({
      sender: "Me <me@test.local>",
      receiver: '"Griffin, Peter" <peter@corp.test>, bo@corp.test',
    });
    expect(chips(to)).toEqual(["peter@corp.test", "bo@corp.test"]);
  });

  it("turns each entered address into its own chip", async () => {
    const { to } = await openReply();
    addChip(to, "bo@corp.test");

    // Adding appends rather than replacing, and the box empties for the next.
    expect(chips(to)).toEqual(["ada@test.local", "bo@corp.test"]);
    expect(to.value).toBe("");
  });

  it("splits a pasted comma-separated list into separate chips", async () => {
    const { to } = await openReply();
    fireEvent.change(to, { target: { value: "one@x.test, two@y.test" } });

    expect(chips(to)).toEqual(["ada@test.local", "one@x.test", "two@y.test"]);
  });

  it("ignores a duplicate address, whatever its case", async () => {
    const { to } = await openReply();
    addChip(to, "ADA@test.local");
    expect(chips(to)).toEqual(["ada@test.local"]);
  });

  it("takes the last chip back into the box on backspace", async () => {
    const { to } = await openReply();
    fireEvent.keyDown(to, { key: "Backspace" });

    // Pulled back for editing rather than destroyed.
    expect(to.value).toBe("ada@test.local");
    expect(chips(to)).toEqual([]);
  });

  it("removes a chip with its × button", async () => {
    const { to } = await openReply();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove ada@test.local" })
    );
    expect(chips(to)).toEqual([]);
  });

  it("sends every To chip, comma-joined for the API", async () => {
    const { to, body } = await openReply();
    addChip(to, "bo@corp.test");
    fireEvent.change(body, { target: { value: "Sounds good." } });

    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@test.local, bo@corp.test" })
    );
  });

  it("names the email it answers, so the reply is threaded", async () => {
    const { body } = await openReply();
    fireEvent.change(body, { target: { value: "Sounds good." } });

    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to_email_id: 42 })
    );
  });

  it("does not thread a forward under the original", async () => {
    render(
      <EmailDetail
        selectedEmail={email}
        viewMode="email"
        onBack={vi.fn()}
        onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { key: "f" });
    fireEvent.change(screen.getByLabelText("Forward recipient"), {
      target: { value: "bo@corp.test" },
    });

    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("reply_to_email_id");
  });

  it("refuses to send with every recipient removed", async () => {
    const { body } = await openReply();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove ada@test.local" })
    );
    fireEvent.change(body, { target: { value: "Sounds good." } });

    send();

    expect(
      await screen.findByText("Enter a recipient for the reply.")
    ).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends an edited subject, and fills a blank one back in", async () => {
    const { subject, body } = await openReply();
    fireEvent.change(subject, { target: { value: "A different subject" } });
    fireEvent.change(body, { target: { value: "Sounds good." } });
    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "A different subject" })
    );
  });

  it("falls back to Re: <subject> when the subject is cleared", async () => {
    const { subject, body } = await openReply();
    fireEvent.change(subject, { target: { value: "" } });
    fireEvent.change(body, { target: { value: "Sounds good." } });
    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Quarterly report" })
    );
  });

  it("keeps edited recipients when Escape closes and R reopens", async () => {
    const { to, body } = await openReply();
    addChip(to, "bo@corp.test");
    fireEvent.keyDown(body, { key: "Escape" });
    expect(screen.queryByLabelText("Reply body")).toBeNull();

    fireEvent.keyDown(document, { key: "r" });

    // Folded back to the one line, which still names both.
    expect(
      screen.getByRole("button", {
        name: "To: ada@test.local, bo@corp.test",
      })
    ).toBeTruthy();
    openRecipients();
    expect(chips(screen.getByLabelText("To") as HTMLInputElement)).toEqual([
      "ada@test.local",
      "bo@corp.test",
    ]);
  });
});

describe("reply composer Cc and Bcc", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  it("starts as one plain To line, with no fields", async () => {
    render(
      <EmailDetail
        selectedEmail={email}
        viewMode="email"
        onBack={vi.fn()}
        onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
      />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { key: "r" });

    expect(
      screen.getByRole("button", { name: "To: ada@test.local" })
    ).toBeTruthy();
    expect(screen.queryByLabelText("To")).toBeNull();
    expect(screen.queryByLabelText("Cc")).toBeNull();
    expect(screen.queryByLabelText("Bcc")).toBeNull();
  });

  it("opens To, Cc and Bcc with a click on that line", async () => {
    const { to } = await openReply();

    expect(chips(to)).toEqual(["ada@test.local"]);
    expect(screen.getByLabelText("Cc")).toBeTruthy();
    expect(screen.getByLabelText("Bcc")).toBeTruthy();
    expect(document.querySelector(".recipient-summary")).toBeNull();
  });

  it("stays open while the only recipient is replaced", async () => {
    const { to } = await openReply();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove ada@test.local" })
    );
    addChip(to, "grace@test.local");

    expect(chips(screen.getByLabelText("To") as HTMLInputElement)).toEqual([
      "grace@test.local",
    ]);
    expect(document.querySelector(".recipient-summary")).toBeNull();
  });

  it("is back to the one line when the reply is cancelled and reopened", async () => {
    await openReply();
    expect(screen.getByLabelText("Cc")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "r" });

    expect(
      screen.getByRole("button", { name: "To: ada@test.local" })
    ).toBeTruthy();
    expect(screen.queryByLabelText("Cc")).toBeNull();
    expect(screen.queryByLabelText("Bcc")).toBeNull();
  });

  it("sends Cc and Bcc as separate lists", async () => {
    const { body } = await openReply();
    addChip(screen.getByLabelText("Cc") as HTMLInputElement, "cc@corp.test");
    addChip(
      screen.getByLabelText("Bcc") as HTMLInputElement,
      "blind@corp.test"
    );
    fireEvent.change(body, { target: { value: "Sounds good." } });

    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@test.local",
        cc: ["cc@corp.test"],
        bcc: ["blind@corp.test"],
      })
    );
  });

  it("omits both when empty rather than sending empty lists", async () => {
    const { body } = await openReply();
    fireEvent.change(body, { target: { value: "Sounds good." } });
    send();

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const payload = sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
  });
});
