// Forward carries the original email's attachments: they show in the forward
// box, any can be left out with ✕, and the rest go to the server by id, which
// fetches the files from the mail provider.
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
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
  attachments: [
    { id: 501, email_id: 42, filename: "report.pdf", size: 2048 },
    { id: 502, email_id: 42, filename: "chart.png", size: 1024 },
  ],
};

async function openForward(selected: EmailItem = email) {
  render(
    <EmailDetail
      selectedEmail={selected}
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
}

const forwarded = () =>
  screen.queryByLabelText("Attachments from the original email");

const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

describe("forwarding an email's attachments", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  it("lists the original's attachments in the forward box", async () => {
    await openForward();
    const box = forwarded();
    expect(box).not.toBeNull();
    expect(within(box as HTMLElement).getByText(/report\.pdf/)).toBeTruthy();
    expect(within(box as HTMLElement).getByText(/chart\.png/)).toBeTruthy();
  });

  it("sends every attachment's id by default", async () => {
    await openForward();
    send();
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      forward_attachment_ids: [501, 502],
    });
  });

  it("leaves out an attachment removed with ✕", async () => {
    await openForward();
    fireEvent.click(screen.getByLabelText("Don't forward chart.png"));
    expect(
      within(forwarded() as HTMLElement).queryByText(/chart\.png/)
    ).toBeNull();
    send();
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      forward_attachment_ids: [501],
    });
  });

  it("sends no attachment ids for an email without attachments", async () => {
    await openForward({ ...email, attachments: [] });
    expect(forwarded()).toBeNull();
    send();
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail.mock.calls[0][0].forward_attachment_ids).toBeUndefined();
  });

  it("refuses a forward over the 25 MB limit before sending", async () => {
    await openForward({
      ...email,
      attachments: [
        { id: 601, email_id: 42, filename: "huge.zip", size: 26 * 1024 * 1024 },
      ],
    });
    send();
    await waitFor(() =>
      expect(
        screen.getByText("Attachments exceed the 25 MB limit")
      ).toBeTruthy()
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
