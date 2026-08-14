// The reply composer's To and Subject fields: seeded from the message when it
// opens, editable from there, and what actually reaches sendEmail.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

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

function setup(overrides: Partial<EmailItem> = {}) {
  render(
    <EmailDetail
      selectedEmail={{ ...email, ...overrides }}
      viewMode="email"
      onBack={vi.fn()}
      onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

async function openReply(overrides: Partial<EmailItem> = {}) {
  setup(overrides);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.keyDown(document, { key: "r" });
  return {
    to: screen.getByLabelText("Reply recipient") as HTMLInputElement,
    subject: screen.getByLabelText("Reply subject") as HTMLInputElement,
    body: screen.getByLabelText("Reply body") as HTMLTextAreaElement,
  };
}

describe("reply composer To and Subject", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  it("defaults the recipient to the sender's address, without the display name", async () => {
    const { to } = await openReply();
    expect(to.value).toBe("ada@test.local");
  });

  it("defaults the subject to the thread's, prefixed with Re:", async () => {
    const { subject } = await openReply();
    expect(subject.value).toBe("Re: Quarterly report");
  });

  it("does not stack a second Re: on a subject that already has one", async () => {
    const { subject } = await openReply({ subject: "Re: Request to schedule call" });
    expect(subject.value).toBe("Re: Request to schedule call");
  });

  it("sends what the fields say, not what they were seeded with", async () => {
    const { to, subject, body } = await openReply();
    fireEvent.change(to, { target: { value: "someone.else@corp.test" } });
    fireEvent.change(subject, { target: { value: "A different subject" } });
    fireEvent.change(body, { target: { value: "Sounds good." } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 7,
        to: "someone.else@corp.test",
        subject: "A different subject",
        body: "Sounds good.",
      })
    );
  });

  it("refuses to send with the recipient cleared", async () => {
    const { to, body } = await openReply();
    fireEvent.change(to, { target: { value: "  " } });
    fireEvent.change(body, { target: { value: "Sounds good." } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Clearing To is a deliberate edit, so it errors rather than quietly
    // falling back to the sender it was seeded with.
    expect(await screen.findByText("Enter a recipient for the reply.")).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fills a blank subject back in, since a subjectless reply helps nobody", async () => {
    const { subject, body } = await openReply();
    fireEvent.change(subject, { target: { value: "" } });
    fireEvent.change(body, { target: { value: "Sounds good." } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Quarterly report" })
    );
  });

  it("keeps an edited recipient when Escape closes and R reopens", async () => {
    const { to, body } = await openReply();
    fireEvent.change(to, { target: { value: "someone.else@corp.test" } });
    fireEvent.keyDown(body, { key: "Escape" });
    expect(screen.queryByLabelText("Reply body")).toBeNull();

    fireEvent.keyDown(document, { key: "r" });

    expect((screen.getByLabelText("Reply recipient") as HTMLInputElement).value)
      .toBe("someone.else@corp.test");
  });
});
