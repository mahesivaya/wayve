// The @mention picker in the reply composer, end to end through the hook: the
// query reaching the contacts search, what each row shows, and what picking one
// puts in the body. Before the address fix, typing a full address closed the
// menu outright.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

const searchContacts = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  downloadEmailAttachment: vi.fn().mockResolvedValue(undefined),
  getGmailConnectUrl: vi.fn().mockResolvedValue("https://accounts.test/oauth"),
  filesToAttachments: vi.fn().mockResolvedValue([]),
  searchContacts: (q: string) => searchContacts(q),
}));

vi.mock("../../api/sharedInboxes", () => ({
  updateEmailState: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@test.local" } }),
}));

import { EmailDetail } from "../../emails/EmailDetail";
import type { EmailItem } from "../../emails/types";

const BOUNCE = "bounce+9e20b4.e6d86c-maheshpy85=gmail.com@mg.nityo.com";

const CONTACTS = [
  {
    address: "maheshy85@gmail.com",
    display_name: "Mahesh Y",
    photo_url: null,
  },
  // No display name: mentionLabel falls back to the address, which is what used
  // to render it twice in one row.
  { address: BOUNCE, display_name: null, photo_url: null },
];

const email: EmailItem = {
  id: 42,
  account_id: 7,
  subject: "Quarterly report",
  sender: "Ada Lovelace <ada@test.local>",
  receiver: "me@test.local",
  body: "Numbers attached.",
  created_at: "2026-07-01T12:00:00Z",
};

function setup() {
  render(
    <EmailDetail
      selectedEmail={email}
      viewMode="email"
      onBack={vi.fn()}
      onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

async function flushMountEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The hook debounces 180ms before searching, then resolves a promise.
async function typeMention(text: string) {
  const box = screen.getByLabelText("Reply body") as HTMLTextAreaElement;
  fireEvent.change(box, {
    target: { value: text, selectionStart: text.length },
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  return box;
}

describe("reply composer @mention picker", () => {
  beforeEach(() => {
    searchContacts.mockReset();
    searchContacts.mockResolvedValue(CONTACTS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps searching once a full address is typed", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });

    await typeMention("@maheshy85@gmail.com");

    // The whole address reaches the backend, and the menu is still open.
    expect(searchContacts).toHaveBeenCalledWith("maheshy85@gmail.com");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("shows the address alone, once per row", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });

    await typeMention("@mahesh");

    const [first] = screen.getAllByRole("option");
    expect(within(first).getByText("maheshy85@gmail.com")).toBeTruthy();
    // The display name no longer gets its own line above the address.
    expect(within(first).queryByText("Mahesh Y")).toBeNull();
    // And the nameless contact renders its address exactly once, not twice.
    expect(screen.getAllByText(BOUNCE)).toHaveLength(1);
  });

  it("inserts the address, and Cc's it, when a row is picked", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });
    const box = await typeMention("@mahesh");

    const [first] = screen.getAllByRole("option");
    fireEvent.mouseDown(first);

    expect(box.value).toBe("@maheshy85@gmail.com ");

    // The Cc row stays shut — it opens only when asked for — so the count on
    // the toggle is what shows the address was added.
    expect(screen.queryByLabelText("Cc")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Cc (1)" });

    // Opening it shows the chip that actually reaches the wire.
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Cc")).toBeTruthy();
    expect(screen.getByText("maheshy85@gmail.com")).toBeTruthy();
  });

  it("paints the inserted mention, and only the mention, in the body", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });
    const box = await typeMention("hi @mahesh");

    fireEvent.mouseDown(screen.getAllByRole("option")[0]);

    // The textarea still holds the whole plain string — the colour comes from
    // the mirror behind it.
    expect(box.value).toBe("hi @maheshy85@gmail.com ");
    const painted = document.querySelectorAll(".email-reply-mention");
    expect(painted).toHaveLength(1);
    expect(painted[0].textContent).toBe("@maheshy85@gmail.com");
  });

  it("does not search on a one-character query", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });

    await typeMention("@m");

    expect(searchContacts).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
