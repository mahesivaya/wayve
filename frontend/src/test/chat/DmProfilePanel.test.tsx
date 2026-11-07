// Clicking a DM's name opens this panel: who the person is, the channels you
// share, and every file sent in the conversation (newest first, paged).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "../../api/chat";
import DmProfilePanel from "../../chat/components/DmProfilePanel";

const getPeerProfile = vi.fn();
const getDmFiles = vi.fn();
const downloadAttachment = vi.fn();

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  getPeerProfile: (...args: unknown[]) => getPeerProfile(...args),
  getDmFiles: (...args: unknown[]) => getDmFiles(...args),
}));

// The envelope is opaque here: "decrypting" just exposes the descriptors the
// test put on each message.
vi.mock("../../chat/e2ee", () => ({
  decryptChatMessages: async (messages: ChatMessage[]) => messages,
}));

vi.mock("../../chat/attachmentFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../chat/attachmentFiles")>()),
  downloadAttachment: (...args: unknown[]) => downloadAttachment(...args),
}));

const ME = 1;
const PEER = { id: 2, email: "ada@x.test" };

const fileMessage = (
  id: number,
  sender: number,
  names: string[]
): ChatMessage => ({
  message_id: id,
  sender_id: sender,
  receiver_id: sender === ME ? PEER.id : ME,
  content: "envelope",
  status: "read",
  created_at: "2026-11-01T10:00:00Z",
  attachments: names.map((name, i) => ({
    id: id * 10 + i,
    name,
    mime: name.endsWith(".png") ? "image/png" : "application/pdf",
    size: 2048,
  })),
});

const renderPanel = (onOpenChannel = vi.fn()) =>
  render(
    <DmProfilePanel
      peer={PEER}
      presence={{ online: true, lastSeen: null, status: "away" }}
      currentUserId={ME}
      onClose={vi.fn()}
      onOpenChannel={onOpenChannel}
    />
  );

beforeEach(() => {
  getPeerProfile.mockReset().mockResolvedValue({
    id: PEER.id,
    email: PEER.email,
    first_name: "Ada",
    last_name: "Lovelace",
    username: "ada",
    has_avatar: false,
    chat_status: "away",
    last_seen: null,
    organization_name: "Analytical Engines",
    member_since: "2025-01-15T00:00:00Z",
    shared_channels: [{ id: 9, name: "general" }],
  });
  getDmFiles.mockReset();
  downloadAttachment.mockReset().mockResolvedValue(undefined);
});

describe("DmProfilePanel", () => {
  it("shows who the person is and the channels you share", async () => {
    getDmFiles.mockResolvedValue([]);
    const onOpenChannel = vi.fn();
    renderPanel(onOpenChannel);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("@ada")).toBeTruthy();
    expect(screen.getByText("Away")).toBeTruthy();
    expect(screen.getByText("Analytical Engines")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: PEER.email }).getAttribute("href")
    ).toBe(`mailto:${PEER.email}`);
    expect(await screen.findByText("No files shared yet.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "# general" }));
    expect(onOpenChannel).toHaveBeenCalledWith(9);
  });

  it("lists every file in the conversation and downloads on click", async () => {
    getDmFiles.mockResolvedValue([
      fileMessage(30, PEER.id, ["plan.pdf"]),
      fileMessage(20, ME, ["shot.png", "notes.pdf"]),
    ]);
    renderPanel();

    const label = await screen.findByText("Files (3)");
    const section = label.closest(".channel-settings-section") as HTMLElement;
    const names = within(section)
      .getAllByRole("button")
      .map((b) => b.querySelector(".dm-profile-file-name")?.textContent);
    expect(names).toEqual(["plan.pdf", "shot.png", "notes.pdf"]);
    // Who sent each one.
    expect(within(section).getAllByText(/· You ·/)).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /plan\.pdf/ }));
    expect(downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "plan.pdf" }),
      expect.objectContaining({ message_id: 30 }),
      ME
    );
  });

  it("pages back through older files", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      fileMessage(100 - i, PEER.id, [`f${100 - i}.pdf`])
    );
    getDmFiles
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([fileMessage(10, ME, ["old.pdf"])]);
    renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Load older files" })
    );
    expect(getDmFiles).toHaveBeenLastCalledWith(PEER.id, 51);
    expect(await screen.findByText("old.pdf")).toBeTruthy();
    expect(screen.getByText("Files (51)")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Load older files" })
    ).toBeNull();
  });
});
