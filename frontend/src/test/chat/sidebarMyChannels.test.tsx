// Organization and platform sidebars start with only the channels you're in;
// "Browse channels" reveals the rest of the tenant's channels to join.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatChannel } from "../../api/chat";

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ setSearchQuery: vi.fn() }),
}));
vi.mock("../../chat/components/StatusSelector", () => ({
  default: () => null,
}));

import ConversationSidebar from "../../chat/components/ConversationSidebar";

const channel = (id: number, name: string, isMember: boolean): ChatChannel => ({
  id,
  name,
  visibility: "public",
  created_by: 1,
  created_at: "2026-11-01T00:00:00Z",
  is_member: isMember,
  member_ids: [],
  member_emails: [],
});

const renderSidebar = (channels: ChatChannel[], myChannelsByDefault: boolean) =>
  render(
    <ConversationSidebar
      myUserId={1}
      users={[{ id: 2, email: "ann@org.test" }]}
      channels={channels}
      myChannelsByDefault={myChannelsByDefault}
      selectedConversation={null}
      creatingChannel={false}
      channelName=""
      channelVisibility="public"
      canChooseVisibility={false}
      channelError=""
      onToggleCreateChannel={vi.fn()}
      onChannelNameChange={vi.fn()}
      onChannelVisibilityChange={vi.fn()}
      onCancelCreateChannel={vi.fn()}
      onCreateChannel={vi.fn()}
      onSelectChannel={vi.fn()}
      onJoinChannel={vi.fn()}
      onSelectUser={vi.fn()}
      onStartChat={vi.fn()}
      summary={{ conversations: [], total_unread: 0 }}
      presence={new Map()}
    />
  );

describe("chat sidebar channels", () => {
  const channels = [
    channel(1, "mine", true),
    channel(2, "elsewhere", false),
    channel(3, "also-elsewhere", false),
  ];

  it("lists only my channels until I browse", () => {
    renderSidebar(channels, true);
    expect(screen.getByText("mine")).toBeTruthy();
    expect(screen.queryByText("elsewhere")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Browse channels (2 more)" })
    );
    expect(screen.getByText("elsewhere")).toBeTruthy();
    expect(screen.getByText("also-elsewhere")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Show only my channels" })
    );
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("says so when I'm in no channels", () => {
    renderSidebar([channel(2, "elsewhere", false)], true);
    expect(screen.getByText("You're not in any channels yet.")).toBeTruthy();
  });

  it("lists every channel when not limited", () => {
    renderSidebar(channels, false);
    expect(screen.getByText("elsewhere")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Browse channels/ })
    ).toBeNull();
  });
});
