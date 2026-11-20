// Following a channel link (`/chat?c=<id>`) to a channel that isn't in the
// reader's list: a personal account's public channel, which only its number
// leads to. The page looks it up, opens it on its join page, and joins from
// there. A link that leads nowhere says so. Drives the real page; only the API,
// the socket and the panes around the message list are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const h = vi.hoisted(() => ({ channels: [] as Record<string, unknown>[] }));
const api = vi.hoisted(() => ({
  getChannelPreview: vi.fn(),
  joinChatChannel: vi.fn(),
  getChannelMessages: vi.fn(),
}));

vi.mock("../../api/chat", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getChatUsers: vi.fn(async () => []),
  getChatChannels: vi.fn(async () => h.channels),
  getChatConversationSummary: vi.fn(async () => ({
    total_unread: 0,
    conversations: [],
  })),
  getChannelPreview: api.getChannelPreview,
  joinChatChannel: api.joinChatChannel,
  getChannelMessages: api.getChannelMessages,
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@test.local", account_type: "personal" },
  }),
}));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));
vi.mock("../../chat/e2ee", () => ({
  decryptChatMessage: vi.fn(async (m: unknown) => m),
  decryptChatMessages: vi.fn(async (m: unknown) => m),
}));
vi.mock("../../crypto/keyStore", () => ({ loadPublicKey: vi.fn() }));
vi.mock("../../chat/hooks/useChatSocket", () => ({
  useChatSocket: () => ({
    wsRef: { current: null },
    isConnected: true,
    isReconnecting: false,
  }),
}));
vi.mock("../../chat/hooks/usePresence", () => ({
  usePresence: () => ({ presence: new Map(), applyPresenceEvent: vi.fn() }),
}));
vi.mock("../../chat/components/ConversationSidebar", () => ({
  default: (props: { channels: { id: number; name: string }[] }) => (
    <div data-testid="listed">
      {props.channels.map((c) => c.name).join(",")}
    </div>
  ),
}));
vi.mock("../../chat/components/ChatHeader", () => ({
  default: (props: {
    title: string;
    selectedChannel: { is_member: boolean } | null;
    onJoinChannel: (c: unknown) => void;
  }) => (
    <div>
      <span data-testid="title">{props.title}</span>
      {props.selectedChannel && !props.selectedChannel.is_member && (
        <button onClick={() => props.onJoinChannel(props.selectedChannel)}>
          join
        </button>
      )}
    </div>
  ),
}));
vi.mock("../../chat/components/MessageComposer", () => ({
  default: () => <div />,
}));

import Chat from "../../chat/Chat";
import { forgetOpenChat } from "../../chat/openChatSession";

const Url = () => {
  const { pathname, search } = useLocation();
  return <span data-testid="url">{pathname + search}</span>;
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Url />
      <Routes>
        <Route path="/chat" element={<Chat />} />
      </Routes>
    </MemoryRouter>
  );

const linked = {
  id: 77,
  name: "book club",
  visibility: "public",
  is_member: false,
  member_count: 12,
  member_emails: [],
  member_ids: [],
  created_by: 40,
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  forgetOpenChat();
  h.channels = [];
  api.getChannelPreview.mockReset();
  api.joinChatChannel.mockReset().mockResolvedValue({ status: "joined" });
  api.getChannelMessages.mockReset().mockResolvedValue([]);
});

describe("following a channel link", () => {
  it("opens an unlisted channel on its join page, and joins from there", async () => {
    api.getChannelPreview.mockResolvedValue(linked);
    renderAt("/chat?c=77&t=tok77");

    await waitFor(() =>
      expect(screen.getByTestId("title").textContent).toContain("book club")
    );
    expect(api.getChannelPreview).toHaveBeenCalledWith(77, "tok77");
    expect(
      screen.getByText("Join this public channel to read and write messages.")
    ).toBeTruthy();
    expect(screen.getByTestId("listed").textContent).toBe("book club");
    // Not a member yet, so its messages were not asked for.
    expect(api.getChannelMessages).not.toHaveBeenCalled();
    // The token stays in the address while on the join page, so a refresh
    // still opens it.
    expect(screen.getByTestId("url").textContent).toBe("/chat?c=77&t=tok77");

    h.channels = [{ ...linked, is_member: true, member_ids: [1] }];
    await userEvent.setup().click(screen.getByText("join"));

    expect(api.joinChatChannel).toHaveBeenCalledWith(77, "tok77");
    await waitFor(() =>
      expect(api.getChannelMessages).toHaveBeenCalledWith(77)
    );
    await waitFor(() => expect(screen.queryByText("join")).toBeNull());
  });

  it("says so when the link leads nowhere, and drops it from the address", async () => {
    api.getChannelPreview.mockResolvedValue(null);
    renderAt("/chat?c=404&t=wrong");

    expect(
      await screen.findByText(/This channel link can't be opened/)
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toBe("/chat")
    );
    expect(screen.getByTestId("listed").textContent).toBe("");
  });

  it("does not look up a channel that is already listed", async () => {
    h.channels = [{ ...linked, is_member: true, member_ids: [1] }];
    renderAt("/chat?c=77");

    await waitFor(() =>
      expect(api.getChannelMessages).toHaveBeenCalledWith(77)
    );
    expect(api.getChannelPreview).not.toHaveBeenCalled();
  });
});
