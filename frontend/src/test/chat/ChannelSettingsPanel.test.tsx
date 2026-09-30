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
  it("lets an admin promote a member and demote an admin", async () => {
    const { onChangeRole } = renderPanel(channel(), true);
    await userEvent.click(screen.getByRole("button", { name: "Make admin" }));
    expect(onChangeRole).toHaveBeenCalledWith("b@x.test", "admin");
    await userEvent.click(screen.getByRole("button", { name: "Make member" }));
    expect(onChangeRole).toHaveBeenCalledWith("a@x.test", "user");
  });

  it("gives a regular member Leave but no role controls", async () => {
    const { onLeave } = renderPanel(
      channel({ current_user_role: "user", can_manage: false }),
      false
    );
    expect(screen.queryByRole("button", { name: "Make admin" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Leave channel" }));
    expect(onLeave).toHaveBeenCalled();
  });

  it("explains owner recovery of a channel with no admin", () => {
    renderPanel(
      channel({ is_member: false, current_user_role: undefined, admin_emails: [] }),
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
