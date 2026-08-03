// Gmail-style shortcuts on the open message: R replies, F forwards, D deletes
// (behind the existing confirm), Escape peels one layer off. The cases that
// matter most are the ones where a shortcut must NOT act: typing "reply" into
// the composer, and Escape while a popup owns the keyboard.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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
  // Plain text on purpose: isHtmlBody() is false, so EmailBody skips the
  // iframe path entirely and jsdom's frame limitations stay out of the way.
  body: "Numbers attached.",
  created_at: "2026-07-01T12:00:00Z",
};

function setup(overrides: Partial<Parameters<typeof EmailDetail>[0]> = {}) {
  const onBack = vi.fn();
  const onDeleteEmail = vi.fn().mockResolvedValue(undefined);
  render(
    <EmailDetail
      selectedEmail={email}
      viewMode="email"
      onBack={onBack}
      onDeleteEmail={onDeleteEmail}
      {...overrides}
    />
  );
  return { onBack, onDeleteEmail };
}

// Two mount effects defer to setTimeout(…, 0) — the composer reset and the
// pane focus. A key fired before they run would have its state wiped.
async function flushMountEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("EmailDetail keyboard shortcuts", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the reply box on R and focuses it", async () => {
    setup();
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "r" });

    const box = screen.getByLabelText("Reply body");
    expect(box).toBe(document.activeElement);
  });

  it("leaves the reply box open when R is typed into it", async () => {
    setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });

    const box = screen.getByLabelText("Reply body");
    fireEvent.keyDown(box, { key: "r" });

    expect(screen.getByLabelText("Reply body")).toBeTruthy();
  });

  it("seeds the quoted body on F", async () => {
    setup();
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "f" });

    const box = screen.getByLabelText("Forward body") as HTMLTextAreaElement;
    expect(box.value).toContain("---------- Forwarded message ---------");
    expect(box.value).toContain("Quarterly report");
    expect(box.value).toContain("Numbers attached.");
  });

  it("deletes on D once the confirm is accepted", async () => {
    const { onDeleteEmail } = setup();
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "d" });

    expect(onDeleteEmail).toHaveBeenCalledWith(42);
  });

  it("does not delete when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onDeleteEmail } = setup();
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "d" });

    expect(onDeleteEmail).not.toHaveBeenCalled();
  });

  it("closes the composer on Escape without leaving the message", async () => {
    const { onBack } = setup();
    await flushMountEffects();
    fireEvent.keyDown(document, { key: "r" });

    fireEvent.keyDown(screen.getByLabelText("Reply body"), { key: "Escape" });

    expect(screen.queryByLabelText("Reply body")).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("leaves the message on Escape when nothing is open", async () => {
    const { onBack } = setup();
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("stands down on Escape while a menu owns the keyboard", async () => {
    const { onBack } = setup();
    await flushMountEffects();
    fireEvent.click(screen.getByLabelText("More actions"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onBack).not.toHaveBeenCalled();
  });

  it("is inert with no email selected", async () => {
    const { onDeleteEmail, onBack } = setup({ selectedEmail: null });
    await flushMountEffects();

    fireEvent.keyDown(document, { key: "r" });
    fireEvent.keyDown(document, { key: "d" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByLabelText("Reply body")).toBeNull();
    expect(onDeleteEmail).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});
