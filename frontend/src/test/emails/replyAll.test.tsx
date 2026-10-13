// The Reply all button: shown next to Reply only when the message went to more
// than one person (To and Cc together), seeding To with the sender and the To
// recipients and Cc with the Cc recipients, leaving you out, and switching back
// to Reply's recipients when Reply is pressed.
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
  subject: "Offsite plans",
  sender: "Ada Lovelace <ada@test.local>",
  receiver: "me@test.local, Bo <bo@test.local>",
  cc: '"Lee, Dan" <dan@test.local>',
  body: "Thoughts?",
  created_at: "2026-07-01T12:00:00Z",
};

async function show(overrides: Partial<EmailItem> = {}) {
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
}

const replyAllButton = () =>
  screen.queryByRole("button", { name: "Reply all" });

/** The addresses chipped in the row whose input is labelled `label`. */
function chips(label: string): string[] {
  const row = screen.getByLabelText(label).closest(".recipient-field");
  return Array.from(row?.querySelectorAll(".recipient-chip") ?? []).map(
    (el) => el.firstChild?.textContent?.trim() ?? ""
  );
}

describe("Reply all", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  it("is not offered for a message to one person", async () => {
    await show({ receiver: "me@test.local", cc: "" });
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
    expect(replyAllButton()).toBeNull();
  });

  it("is offered for more than one To recipient", async () => {
    await show({ cc: null });
    expect(replyAllButton()).toBeTruthy();
  });

  it("is offered when the second recipient is on Cc", async () => {
    await show({ receiver: "me@test.local", cc: "carol@test.local" });
    expect(replyAllButton()).toBeTruthy();
  });

  it("sits right after Reply", async () => {
    await show();
    const reply = screen.getByRole("button", { name: "Reply" });
    expect(reply.nextElementSibling).toBe(replyAllButton());
  });

  it("addresses the sender and To recipients, Cc's the Cc, and leaves you out", async () => {
    await show();
    fireEvent.click(replyAllButton() as HTMLElement);

    expect(chips("To")).toEqual(["ada@test.local", "bo@test.local"]);
    // The Cc row opens, so nobody is added unseen.
    expect(chips("Cc")).toEqual(["dan@test.local"]);

    fireEvent.change(screen.getByLabelText("Reply body"), {
      target: { value: "Count me in." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@test.local, bo@test.local",
        cc: ["dan@test.local"],
        subject: "Re: Offsite plans",
        reply_to_email_id: 42,
      })
    );
  });

  it("opens with the A shortcut", async () => {
    await show();
    fireEvent.keyDown(document, { key: "a" });
    expect(chips("To")).toEqual(["ada@test.local", "bo@test.local"]);
  });

  it("switches back to the sender alone when Reply is pressed", async () => {
    await show();
    fireEvent.click(replyAllButton() as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(chips("To")).toEqual(["ada@test.local"]);
    expect(chips("Cc")).toEqual([]);
  });

  it("closes when pressed again", async () => {
    await show();
    fireEvent.click(replyAllButton() as HTMLElement);
    expect(screen.queryByLabelText("Reply body")).toBeTruthy();
    fireEvent.click(replyAllButton() as HTMLElement);
    expect(screen.queryByLabelText("Reply body")).toBeNull();
  });

  it("keeps the Cc when reopened after Cancel, and keeps an edited To", async () => {
    await show();
    fireEvent.click(replyAllButton() as HTMLElement);
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "eve@test.local," },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(replyAllButton() as HTMLElement);

    expect(chips("To")).toEqual([
      "ada@test.local",
      "bo@test.local",
      "eve@test.local",
    ]);
    expect(chips("Cc")).toEqual(["dan@test.local"]);

    fireEvent.change(screen.getByLabelText("Reply body"), {
      target: { value: "Count me in." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ cc: ["dan@test.local"] })
    );
  });

  describe("opened before the message finished loading", () => {
    // The list row has no Cc; it comes with the full message.
    const { cc: _cc, ...row } = email;
    void _cc;

    async function openEarly() {
      const view = render(
        <EmailDetail
          selectedEmail={row}
          viewMode="email"
          onBack={vi.fn()}
          onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
        />
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      fireEvent.click(replyAllButton() as HTMLElement);
      return async (loaded: EmailItem) => {
        view.rerender(
          <EmailDetail
            selectedEmail={loaded}
            viewMode="email"
            onBack={vi.fn()}
            onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
          />
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
    }

    it("adds the Cc when it arrives", async () => {
      const arrive = await openEarly();
      expect(chips("To")).toEqual(["ada@test.local", "bo@test.local"]);
      expect(screen.queryByLabelText("Cc")).toBeNull();

      await arrive(email);

      expect(chips("Cc")).toEqual(["dan@test.local"]);
      fireEvent.change(screen.getByLabelText("Reply body"), {
        target: { value: "Count me in." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendEmail).toHaveBeenCalled());
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ cc: ["dan@test.local"] })
      );
    });

    it("adds it once, so a Cc removed afterwards stays removed", async () => {
      const arrive = await openEarly();
      await arrive(email);
      fireEvent.click(
        screen.getByRole("button", { name: "Remove dan@test.local" })
      );

      // A later update to the same message, with a Cc that differs, must not
      // run the add again.
      await arrive({ ...email, cc: "dan@test.local, frank@test.local" });

      expect(chips("Cc")).toEqual([]);
    });

    it("never adds another message's Cc when one is opened first", async () => {
      const arrive = await openEarly();
      // A message that is already loaded (opened before, so cached).
      const other: EmailItem = {
        id: 43,
        account_id: 7,
        subject: "Other",
        sender: "zed@test.local",
        receiver: "me@test.local",
        cc: "carol@test.local",
        created_at: "2026-07-02T12:00:00Z",
      };
      await arrive(other);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      fireEvent.click(screen.getByRole("button", { name: "Reply" }));

      expect(chips("To")).toEqual(["zed@test.local"]);
      expect(screen.queryByLabelText("Cc")).toBeNull();
    });

    it("leaves a reply switched to Reply alone", async () => {
      const arrive = await openEarly();
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));

      await arrive(email);

      expect(chips("To")).toEqual(["ada@test.local"]);
      expect(screen.queryByLabelText("Cc")).toBeNull();
    });
  });

  it("keeps the Cc when reopened with A after Escape", async () => {
    await show();
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Reply body")).toBeNull();

    fireEvent.keyDown(document, { key: "a" });

    expect(chips("Cc")).toEqual(["dan@test.local"]);
  });
});
