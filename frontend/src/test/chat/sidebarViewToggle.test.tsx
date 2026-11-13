// The chat sidebar switches between "All" (Channels + Users directories) and
// "Recent" (every conversation with messages, newest first).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatChannel, ChatConversationSummary } from "../../api/chat";

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ setSearchQuery: vi.fn() }),
}));
vi.mock("../../chat/components/StatusSelector", () => ({
  default: () => null,
}));
const findChatUserByEmail = vi.fn();
vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  findChatUserByEmail: (...args: unknown[]) => findChatUserByEmail(...args),
}));

import ConversationSidebar from "../../chat/components/ConversationSidebar";
import NewConversation from "../../chat/components/NewConversation";

const channel = (
  id: number,
  name: string,
  lastAt: string | null
): ChatChannel => ({
  id,
  name,
  visibility: "public",
  created_by: 1,
  created_at: "2026-11-01T00:00:00Z",
  is_member: true,
  member_ids: [],
  member_emails: [],
  last_message_at: lastAt,
});

const activeChannels = [
  channel(10, "general", "2026-11-12T09:00:00Z"),
  channel(11, "quiet", null),
];

const renderSidebar = (
  summary: ChatConversationSummary,
  channels: ChatChannel[] = activeChannels,
  onNewChat = vi.fn()
) =>
  render(
    <ConversationSidebar
      myUserId={1}
      users={[
        { id: 2, email: "ann@org.test" },
        { id: 3, email: "bob@org.test" },
      ]}
      channels={channels}
      myChannelsByDefault={false}
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
      onNewChat={onNewChat}
      composingNew={false}
      summary={summary}
      presence={new Map()}
    />
  );

const annDm: ChatConversationSummary = {
  conversations: [
    { user_id: 2, unread_count: 3, last_message_at: "2026-11-12T10:00:00Z" },
  ],
  total_unread: 3,
} as ChatConversationSummary;

afterEach(() => localStorage.clear());

describe("chat sidebar All / Recent", () => {
  it("starts on All with the Channels and Users directories", () => {
    renderSidebar(annDm);

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Channels")).toBeTruthy();
    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("quiet")).toBeTruthy();
    expect(screen.getByText("bob@org.test")).toBeTruthy();
  });

  it("Recent lists only conversations with messages, newest first", () => {
    renderSidebar(annDm);
    fireEvent.click(screen.getByRole("tab", { name: /Recent/ }));

    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.queryByText("Users")).toBeNull();
    const rows = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => /ann@|general|bob@|quiet/.test(t));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("ann@org.test");
    expect(rows[1]).toContain("general");
  });

  it("shows the unread total on the Recent tab", () => {
    renderSidebar(annDm);
    expect(screen.getByLabelText("3 unread")).toBeTruthy();
  });

  it("says so when there is nothing recent", () => {
    renderSidebar({ conversations: [], total_unread: 0 }, [
      channel(11, "quiet", null),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    expect(screen.getByText("No recent conversations yet.")).toBeTruthy();
  });

  it("remembers the chosen view", () => {
    const { unmount } = renderSidebar(annDm);
    fireEvent.click(screen.getByRole("tab", { name: /Recent/ }));
    unmount();

    renderSidebar(annDm);
    expect(screen.getByRole("tab", { name: /Recent/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

describe("chat sidebar New chat", () => {
  it("asks the page to open the New conversation view", () => {
    const onNewChat = vi.fn();
    renderSidebar(annDm, activeChannels, onNewChat);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("NewConversation page", () => {
  it("finds someone by username from the To: field and opens the chat", async () => {
    findChatUserByEmail.mockResolvedValue({
      id: 7,
      email: "carol@org.test",
      can_message: true,
    });
    const onFound = vi.fn();
    render(
      <NewConversation
        myUserId={1}
        users={[]}
        onFound={onFound}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByText("You're starting a new conversation")).toBeTruthy();
    const to = screen.getByLabelText("Email or username");
    fireEvent.change(to, { target: { value: "Carol" } });
    fireEvent.keyDown(to, { key: "Enter" });

    await vi.waitFor(() =>
      expect(onFound).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
    );
    expect(findChatUserByEmail).toHaveBeenCalledWith("carol");
  });

  it("explains when nobody matches", async () => {
    findChatUserByEmail.mockResolvedValue(null);
    const onFound = vi.fn();
    render(
      <NewConversation
        myUserId={1}
        users={[]}
        onFound={onFound}
        onBack={vi.fn()}
      />
    );

    const to = screen.getByLabelText("Email or username");
    fireEvent.change(to, { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    expect(
      await screen.findByText("No account matches that email or username.")
    ).toBeTruthy();
    expect(onFound).not.toHaveBeenCalled();
  });
});
