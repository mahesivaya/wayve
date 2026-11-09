// On a phone the open email's bar keeps only Reply, Forward and Delete; the
// other actions move into the ⋮ menu. CSS picks which copy shows, so this
// covers the menu items working.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  subject: "Verify your email",
  sender: "Ada <ada@test.local>",
  receiver: "me@test.local, bob@test.local",
  cc: "",
  body: "Hello!",
  created_at: "2026-11-08T17:04:00Z",
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function openMenu(props: { starred?: boolean } = {}) {
  const onToggleStar = vi.fn().mockResolvedValue(undefined);
  render(
    <EmailDetail
      selectedEmail={email}
      viewMode="email"
      onBack={vi.fn()}
      onDeleteEmail={vi.fn().mockResolvedValue(undefined)}
      onToggleStar={onToggleStar}
      onSnooze={vi.fn().mockResolvedValue(undefined)}
      starred={props.starred ?? false}
    />
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  return { onToggleStar };
}

const item = (name: string) => screen.getByRole("menuitem", { name });

describe("the ⋮ menu's phone actions", () => {
  afterEach(cleanup);

  it("lists the actions the phone bar drops", async () => {
    await openMenu();
    for (const name of ["Reply all", "Add star", "Snooze", "Mark as Noise"]) {
      expect(item(name)).toBeTruthy();
    }
  });

  it("stars from the menu and closes it", async () => {
    const { onToggleStar } = await openMenu();

    fireEvent.click(item("Add star"));

    expect(onToggleStar).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Snooze" })).toBeNull();
  });

  it("names the star action for a starred email", async () => {
    await openMenu({ starred: true });
    expect(item("Remove star")).toBeTruthy();
  });

  it("opens the snooze picker from the menu", async () => {
    await openMenu();

    fireEvent.click(item("Snooze"));

    expect(screen.getByRole("menu", { name: "Snooze until" })).toBeTruthy();
  });

  it("opens Reply all from the menu", async () => {
    await openMenu();

    fireEvent.click(item("Reply all"));
    await settle();

    expect(document.querySelector(".email-reply-box, textarea")).not.toBeNull();
  });
});
