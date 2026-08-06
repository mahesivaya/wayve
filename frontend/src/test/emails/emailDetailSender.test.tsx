// Clicking the sender on an open message offers the two things people actually
// want from an address: copy it, or narrow the list to that sender.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
import type { EmailItem } from "../../emails/types";

const email: EmailItem = {
  id: 42,
  account_id: 7,
  subject: "Quarterly report",
  sender: "Ada Lovelace <ada@test.local>",
  receiver: "me@test.local",
  // Plain text keeps EmailBody off its iframe path, which jsdom cannot drive.
  body: "Numbers attached.",
  created_at: "2026-07-01T12:00:00Z",
};

function setup(opts: { sender?: string | null; withFilter?: boolean } = {}): {
  onFilterBySender: ReturnType<typeof vi.fn>;
} {
  const { sender = email.sender ?? null, withFilter = true } = opts;
  const onFilterBySender = vi.fn();
  render(
    <EmailDetail
      selectedEmail={{ ...email, sender }}
      viewMode="email"
      onBack={vi.fn()}
      onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
      onFilterBySender={withFilter ? onFilterBySender : undefined}
    />
  );
  return { onFilterBySender };
}

// The mount effects defer to setTimeout(…, 0). An awaited empty act() only
// drains microtasks, so the reset would still be pending and would close the
// menu mid-test; yielding to a real timer is what actually flushes it.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const openMenu = (name: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("EmailDetail sender menu", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("copies the bare address, not the display name", async () => {
    setup();
    await settle();

    openMenu(/ada lovelace/i);
    fireEvent.click(screen.getByRole("menuitem", { name: /copy address/i }));
    await settle();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "ada@test.local"
    );
    expect(
      screen.getByRole("menuitem", { name: /address copied/i })
    ).toBeTruthy();
  });

  it("hands the host the bare address to filter on, then closes", async () => {
    const { onFilterBySender } = setup();
    await settle();

    openMenu(/ada lovelace/i);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /messages from this sender/i })
    );
    await settle();

    expect(onFilterBySender).toHaveBeenCalledWith("ada@test.local");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers copy only when the host cannot filter", async () => {
    setup({ withFilter: false });
    await settle();

    openMenu(/ada lovelace/i);
    await settle();

    expect(
      screen.getByRole("menuitem", { name: /copy address/i })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: /messages from this sender/i })
    ).toBeNull();
  });

  it("opens for a sender with no display name", async () => {
    // splitSender puts a bare address in `name`, so an address-only trigger
    // would leave these messages unclickable.
    setup({ sender: "solo@test.local" });
    await settle();

    openMenu(/solo@test.local/i);
    await settle();

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    setup();
    await settle();

    openMenu(/ada lovelace/i);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("has no trigger when the message has no sender", async () => {
    setup({ sender: null });
    await settle();

    expect(
      screen
        .getByRole("button", { name: /unknown sender/i })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});
