import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatChannel } from "../../api/chat";
import ChatHeader, {
  type AddMemberControl,
} from "../../chat/components/ChatHeader";

const channel = (overrides: Partial<ChatChannel> = {}): ChatChannel => ({
  id: 7,
  name: "general",
  visibility: "public",
  created_by: 1,
  created_at: "2026-09-01T00:00:00Z",
  is_member: true,
  current_user_role: "admin",
  can_manage: true,
  member_ids: [1],
  member_emails: ["a@x.test"],
  admin_emails: ["a@x.test"],
  ...overrides,
});

const addMemberControl = (
  overrides: Partial<AddMemberControl> = {}
): AddMemberControl => ({
  open: false,
  emails: "",
  error: "",
  onToggle: vi.fn(),
  onEmailsChange: vi.fn(),
  onAdd: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});

const renderHeader = (
  ch: ChatChannel,
  addMember: AddMemberControl | null,
  { settingsOpen = false, onToggleSettings = vi.fn() } = {}
) =>
  render(
    <ChatHeader
      title={ch.name}
      selectedChannel={ch}
      isDirect={false}
      presence={null}
      settingsOpen={settingsOpen}
      onAudioCall={null}
      onVideoCall={null}
      onBack={vi.fn()}
      onToggleSettings={onToggleSettings}
      addMember={addMember}
      onJoinChannel={vi.fn()}
    />
  );

describe("ChatHeader + Add member", () => {
  it("toggles the invite dropdown, not channel settings", async () => {
    const onToggleSettings = vi.fn();
    const addMember = addMemberControl();
    renderHeader(channel(), addMember, { onToggleSettings });
    expect(screen.queryByRole("dialog", { name: "Invite people" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "+ Add member" }));
    expect(addMember.onToggle).toHaveBeenCalledTimes(1);
    expect(onToggleSettings).not.toHaveBeenCalled();
  });

  it("shows only the invite field when open, focused", () => {
    renderHeader(channel(), addMemberControl({ open: true }));
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    const input = screen.getByRole("textbox", { name: "Emails to invite" });
    expect(dialog.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("adds on Enter and on the Add button", async () => {
    const addMember = addMemberControl({ open: true, emails: "c@x.test" });
    renderHeader(channel(), addMember);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(addMember.onAdd).toHaveBeenCalledTimes(2);
  });

  it("disables Add while the field is empty", () => {
    renderHeader(channel(), addMemberControl({ open: true }));
    expect(
      (screen.getByRole("button", { name: "Add" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("closes on Escape and on a click outside", async () => {
    const addMember = addMemberControl({ open: true });
    renderHeader(channel(), addMember);
    await userEvent.keyboard("{Escape}");
    expect(addMember.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("heading"));
    expect(addMember.onClose).toHaveBeenCalledTimes(2);
  });

  it("shows the invite error", () => {
    renderHeader(
      channel(),
      addMemberControl({ open: true, error: "No such user" })
    );
    expect(screen.getByText("No such user")).toBeTruthy();
  });

  it("is hidden when the viewer can't invite", () => {
    renderHeader(channel({ current_user_role: "user" }), null);
    expect(screen.queryByRole("button", { name: "+ Add member" })).toBeNull();
  });

  it("is hidden for a non-member", () => {
    renderHeader(channel({ is_member: false }), addMemberControl());
    expect(screen.queryByRole("button", { name: "+ Add member" })).toBeNull();
  });
});

describe("ChatHeader channel name", () => {
  it("opens settings when a member clicks it", async () => {
    const onToggleSettings = vi.fn();
    renderHeader(channel(), null, { onToggleSettings });
    const name = screen.getByRole("button", { name: "general" });
    expect(name.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(name);
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
  });

  it("closes settings when they are already open", async () => {
    const onToggleSettings = vi.fn();
    renderHeader(channel(), null, { settingsOpen: true, onToggleSettings });
    const name = screen.getByRole("button", { name: "general" });
    expect(name.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(name);
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
  });

  it("is plain text for a non-member", () => {
    renderHeader(channel({ is_member: false }), null);
    expect(screen.queryByRole("button", { name: "general" })).toBeNull();
  });
});
