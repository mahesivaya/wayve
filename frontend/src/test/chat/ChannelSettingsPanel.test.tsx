import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatChannel } from "../../api/chat";
import ChannelSettingsPanel from "../../chat/components/ChannelSettingsPanel";
import { isChannelAdmin } from "../../chat/utils";

const channel = (overrides: Partial<ChatChannel> = {}): ChatChannel => ({
  id: 7,
  name: "general",
  visibility: "private",
  created_by: 1,
  created_at: "2026-09-01T00:00:00Z",
  is_member: true,
  current_user_role: "admin",
  can_manage: true,
  member_ids: [1, 2],
  member_emails: ["a@x.test", "b@x.test"],
  admin_emails: ["a@x.test"],
  ...overrides,
});

const renderPanel = (ch: ChatChannel, isAdmin: boolean) => {
  const handlers = {
    onChangeRole: vi.fn(),
    onLeave: vi.fn(),
    onDelete: vi.fn(),
    onDeleteUser: vi.fn(),
  };
  render(
    <ChannelSettingsPanel
      channel={ch}
      isAdmin={isAdmin}
      admins={ch.admin_emails ?? []}
      users={ch.member_emails}
      subjectDraft={ch.name}
      visibilityDraft={ch.visibility}
      addUserRole="user"
      addUserEmails=""
      error=""
      onSubjectDraftChange={vi.fn()}
      onVisibilityDraftChange={vi.fn()}
      onAddUserRoleChange={vi.fn()}
      onAddUserEmailsChange={vi.fn()}
      onSaveSubject={vi.fn()}
      onSaveVisibility={vi.fn()}
      onAddUsers={vi.fn()}
      onApproveJoinRequest={vi.fn()}
      {...handlers}
    />
  );
  return handlers;
};

describe("ChannelSettingsPanel roles and leaving", () => {
  it("lets an admin promote a member", async () => {
    const { onChangeRole } = renderPanel(channel(), true);
    await userEvent.click(screen.getByRole("button", { name: "Make admin" }));
    expect(onChangeRole).toHaveBeenCalledWith("b@x.test", "admin");
  });

  it("lets an admin demote or remove another admin while one would remain", async () => {
    const { onChangeRole, onDeleteUser } = renderPanel(
      channel({ admin_emails: ["a@x.test", "b@x.test"] }),
      true
    );
    const demote = screen.getAllByRole("button", { name: "Make member" });
    expect(demote).toHaveLength(2);
    await userEvent.click(demote[1]);
    expect(onChangeRole).toHaveBeenCalledWith("b@x.test", "user");
    await userEvent.click(screen.getByRole("button", { name: "Remove b@x.test" }));
    expect(onDeleteUser).toHaveBeenCalledWith("b@x.test");
  });

  it("offers the last admin Delete channel in place of Leave", async () => {
    // a@x.test, the current user, is the only admin: the server refuses a leave.
    const { onDelete, onLeave } = renderPanel(channel(), true);
    expect(screen.queryByRole("button", { name: "Leave channel" })).toBeNull();
    expect(screen.getByText(/You're the only admin/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    expect(onDelete).toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("lets an admin leave while another admin remains", async () => {
    const { onLeave } = renderPanel(
      channel({ admin_emails: ["a@x.test", "b@x.test"] }),
      true
    );
    expect(screen.queryByText(/You're the only admin/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Leave channel" }));
    expect(onLeave).toHaveBeenCalled();
  });

  it("offers the last admin neither Make member nor remove", () => {
    // a@x.test is the only admin: the server would refuse both.
    renderPanel(channel(), true);
    expect(screen.queryByRole("button", { name: "Make member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove a@x.test" })).toBeNull();
    // Members keep their controls.
    expect(screen.getByRole("button", { name: "Make admin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove b@x.test" })).toBeTruthy();
  });

  it("gives a regular member Leave but no role controls", async () => {
    const { onLeave } = renderPanel(
      channel({ current_user_role: "user", can_manage: false }),
      false
    );
    expect(screen.queryByRole("button", { name: "Make admin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Leave channel" })
    );
    expect(onLeave).toHaveBeenCalled();
  });

  it("explains owner recovery of a channel with no admin", () => {
    renderPanel(
      channel({
        is_member: false,
        current_user_role: undefined,
        admin_emails: [],
      }),
      true
    );
    expect(screen.getByText(/This channel has no admin/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Leave channel" })).toBeNull();
  });
});

describe("isChannelAdmin", () => {
  const me = { id: 1, email: "a@x.test" };

  it("trusts the backend's can_manage", () => {
    expect(isChannelAdmin(channel({ can_manage: false }), me)).toBe(false);
    expect(
      isChannelAdmin(channel({ can_manage: true, admin_emails: [] }), me)
    ).toBe(true);
  });

  it("no longer treats a demoted creator as admin", () => {
    expect(
      isChannelAdmin(
        channel({ can_manage: undefined, created_by: 1, admin_emails: [] }),
        me
      )
    ).toBe(false);
  });
});
