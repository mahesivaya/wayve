// A half-written reply or forward comes back when its email opens: composer open,
// fields filled in, and saves carrying on from the same draft. Cancel keeps it,
// Discard and Send end it. The API is stubbed; the composers are real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EmailDraft } from "../../api/emailDrafts";

const api = vi.hoisted(() => ({
  createEmailDraft: vi.fn(),
  updateEmailDraft: vi.fn(),
  deleteEmailDraft: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../../api/emailDrafts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEmailDraft: api.createEmailDraft,
  updateEmailDraft: api.updateEmailDraft,
  deleteEmailDraft: api.deleteEmailDraft,
}));
vi.mock("../../api/email", async (original) => ({
  ...(await original<typeof import("../../api/email")>()),
  sendEmail: api.sendEmail,
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
  sender: "Ada <ada@test.local>",
  receiver: "me@test.local",
  body: "Thoughts?",
  created_at: "2026-07-01T12:00:00Z",
};
const other: EmailItem = { ...email, id: 43, subject: "Something else" };

const draft = (over: Partial<EmailDraft>): EmailDraft => ({
  id: 9,
  kind: "reply",
  source_email_id: 42,
  account_id: 7,
  to: "ada@test.local, bo@test.local",
  cc: "cc@test.local",
  bcc: "bcc@test.local",
  subject: "Re: edited",
  body: "half written",
  created_at: "2026-07-01T12:00:00Z",
  updated_at: "2026-07-01T12:00:00Z",
  ...over,
});

const element = (
  selected: EmailItem | null,
  drafts: EmailDraft[],
  draftsLoaded = true
) => (
  <EmailDetail
    selectedEmail={selected}
    viewMode="email"
    onBack={vi.fn()}
    onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
    drafts={drafts}
    draftsLoaded={draftsLoaded}
  />
);

const tick = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const show = async (
  selected: EmailItem | null,
  drafts: EmailDraft[],
  draftsLoaded = true
) => {
  const view = render(element(selected, drafts, draftsLoaded));
  await tick();
  return view;
};

const replyBox = () =>
  screen.queryByPlaceholderText(
    "Write your reply — @ to mention"
  ) as HTMLTextAreaElement | null;
const forwardBox = () =>
  screen.queryByPlaceholderText(
    "Forward message"
  ) as HTMLTextAreaElement | null;
const SAVE_WAIT = 1650;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.createEmailDraft.mockImplementation(async (d: Partial<EmailDraft>) =>
    draft({ ...d, id: 100 })
  );
  api.updateEmailDraft.mockImplementation(
    async (id: number, d: Partial<EmailDraft>) => draft({ ...d, id })
  );
  api.deleteEmailDraft.mockResolvedValue(undefined);
  api.sendEmail.mockResolvedValue(undefined);
});

describe("restoring a draft", () => {
  it("reopens the reply with every field", async () => {
    await show(email, [draft({})]);

    expect(replyBox()?.value).toBe("half written");
    expect(screen.getByDisplayValue("Re: edited")).toBeTruthy();
    const text = document.querySelector(".email-reply-box")?.textContent ?? "";
    for (const address of [
      "ada@test.local",
      "bo@test.local",
      "cc@test.local",
      "bcc@test.local",
    ]) {
      expect(text).toContain(address);
    }
  });

  it("stays closed when the email has no draft", async () => {
    await show(email, [draft({ source_email_id: 999 })]);
    expect(replyBox()).toBeNull();
    expect(forwardBox()).toBeNull();
  });

  it("waits for the list of drafts to arrive", async () => {
    const view = await show(email, [], false);
    expect(replyBox()).toBeNull();

    view.rerender(element(email, [draft({})], true));
    await tick();
    expect(replyBox()?.value).toBe("half written");
  });

  it("finds a draft written on an older message of the conversation", async () => {
    await show({ ...email, id: 50, message_ids: [42, 50] }, [draft({})]);
    expect(replyBox()?.value).toBe("half written");
  });

  it("restores a forward", async () => {
    await show(email, [
      draft({ kind: "forward", to: "fwd@test.local", body: "FYI" }),
    ]);
    expect(forwardBox()?.value).toBe("FYI");
    expect(
      (screen.getByPlaceholderText("Forward to") as HTMLInputElement).value
    ).toBe("fwd@test.local");
    expect(replyBox()).toBeNull();
  });

  it("opens whichever was worked on last, and keeps the other", async () => {
    await show(email, [
      draft({ id: 2, kind: "forward", to: "fwd@test.local", body: "FYI" }),
      draft({ id: 1, kind: "reply", body: "the reply" }),
    ]);
    expect(forwardBox()?.value).toBe("FYI");

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(replyBox()?.value).toBe("the reply");
  });

  it("restores again when the same email is closed and reopened", async () => {
    const drafts = [draft({})];
    const view = await show(email, drafts);
    view.rerender(element(null, drafts));
    await tick();
    view.rerender(element(email, drafts));
    await tick();
    expect(replyBox()?.value).toBe("half written");
  });

  it("a later save can't overwrite what's being typed", async () => {
    const drafts = [draft({})];
    const view = await show(email, drafts);
    fireEvent.change(replyBox() as HTMLTextAreaElement, {
      target: { value: "typed since" },
    });
    view.rerender(element(email, [draft({ body: "older copy" })]));
    await tick();
    expect(replyBox()?.value).toBe("typed since");
  });

  it("carries on from the same draft, without saving it unchanged", async () => {
    await show(email, [draft({})]);
    await tick(SAVE_WAIT);
    expect(api.updateEmailDraft).not.toHaveBeenCalled();
    expect(api.createEmailDraft).not.toHaveBeenCalled();

    fireEvent.change(replyBox() as HTMLTextAreaElement, {
      target: { value: "half written, and more" },
    });
    await tick(SAVE_WAIT);
    expect(api.updateEmailDraft.mock.calls[0][0]).toBe(9);
    expect(api.createEmailDraft).not.toHaveBeenCalled();
  });
});

describe("writing a draft", () => {
  it("saves a reply against its email", async () => {
    await show(email, []);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(replyBox() as HTMLTextAreaElement, {
      target: { value: "new reply" },
    });
    await tick(SAVE_WAIT);

    expect(api.createEmailDraft.mock.calls[0][0]).toMatchObject({
      kind: "reply",
      source_email_id: 42,
      account_id: 7,
      body: "new reply",
    });
    expect(screen.getByText("Draft saved")).toBeTruthy();
  });

  it("an open reply with nothing typed isn't a draft", async () => {
    await show(email, []);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await tick(SAVE_WAIT);
    expect(api.createEmailDraft).not.toHaveBeenCalled();
  });

  it("a forward holding only the quoted original isn't a draft", async () => {
    await show(email, []);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(forwardBox()?.value).not.toBe("");
    await tick(SAVE_WAIT);
    expect(api.createEmailDraft).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Forward to"), {
      target: { value: "fwd@test.local" },
    });
    await tick(SAVE_WAIT);
    expect(api.createEmailDraft.mock.calls[0][0]).toMatchObject({
      kind: "forward",
      source_email_id: 42,
      to: "fwd@test.local",
      subject: "Fwd: Offsite plans",
    });
  });

  it("files unsaved text under the email it was written on", async () => {
    const view = await show(email, []);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(replyBox() as HTMLTextAreaElement, {
      target: { value: "for the first email" },
    });
    view.rerender(element(other, []));
    await tick(SAVE_WAIT);

    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.createEmailDraft.mock.calls[0][0]).toMatchObject({
      source_email_id: 42,
      body: "for the first email",
    });
    expect(replyBox()).toBeNull();
  });
});

describe("ending a draft", () => {
  it("Cancel closes the composer and keeps the draft", async () => {
    await show(email, [draft({})]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await tick(SAVE_WAIT);
    expect(replyBox()).toBeNull();
    expect(api.deleteEmailDraft).not.toHaveBeenCalled();
  });

  it("Discard deletes it and clears the fields", async () => {
    await show(email, [draft({})]);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await tick();
    expect(api.deleteEmailDraft.mock.calls[0][0]).toBe(9);
    expect(replyBox()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(replyBox()?.value).toBe("");
  });

  it("sending deletes it", async () => {
    await show(email, [draft({})]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await tick();
    expect(api.sendEmail).toHaveBeenCalledTimes(1);
    expect(api.deleteEmailDraft.mock.calls[0][0]).toBe(9);
  });

  it("a failed send keeps it", async () => {
    api.sendEmail.mockRejectedValue(new Error("nope"));
    await show(email, [draft({})]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await tick();
    expect(api.deleteEmailDraft).not.toHaveBeenCalled();
    expect(replyBox()?.value).toBe("half written");
  });
});
