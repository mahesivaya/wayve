// The chat window survives leaving the page. Every route change unmounts Chat and
// the sidebar's /chat link carries no `?dm=`, so coming back from Emails used to
// land on an empty window. Drives the real page; only the API, the socket and the
// panes around the message list are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type { ReactNode } from "react";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const h = vi.hoisted(() => ({
  userId: 1,
  users: [] as { id: number; email: string }[],
  channels: [] as Record<string, unknown>[],
}));

const api = vi.hoisted(() => ({
  getChatMessages: vi.fn(),
  getChannelMessages: vi.fn(),
  getChannelThread: vi.fn(),
  findChatUserByEmail: vi.fn(),
}));

vi.mock("../../api/chat", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getChatUsers: vi.fn(async () => h.users),
  getChatChannels: vi.fn(async () => h.channels),
  getChatConversationSummary: vi.fn(async () => ({
    total_unread: 0,
    conversations: [],
  })),
  getChatMessages: api.getChatMessages,
  getChannelMessages: api.getChannelMessages,
  getChannelThread: api.getChannelThread,
  findChatUserByEmail: api.findChatUserByEmail,
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: h.userId, email: "me@test.local", account_type: "personal" },
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
vi.mock("../../call/useCallSession", () => ({
  useCallSession: () => ({ connected: false, callState: { kind: "idle" } }),
}));
vi.mock("../../call/CallOverlays", () => ({ default: () => null }));
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
  default: (props: {
    users: { id: number; email: string }[];
    channels: { id: number; name: string }[];
    onSelectUser: (u: unknown) => void;
    onSelectChannel: (c: unknown) => void;
  }) => (
    <div>
      {props.users.map((u) => (
        <button key={u.id} onClick={() => props.onSelectUser(u)}>
          {`pick ${u.email}`}
        </button>
      ))}
      {props.channels.map((c) => (
        <button key={c.id} onClick={() => props.onSelectChannel(c)}>
          {`pick ${c.name}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../chat/components/ChatHeader", () => ({
  default: (props: {
    title: string;
    onBack: () => void;
    onToggleSettings: () => void;
  }): ReactNode => (
    <div>
      <span data-testid="title">{props.title}</span>
      <button onClick={props.onBack}>close chat</button>
      <button onClick={props.onToggleSettings}>toggle settings</button>
    </div>
  ),
}));
vi.mock("../../chat/components/MessageComposer", () => ({
  default: (props: {
    input: string;
    onInputChange: (v: string) => void;
    pendingFiles: File[];
    onPickFiles: (f: File[]) => void;
  }) => (
    <div>
      <textarea
        aria-label="draft"
        value={props.input}
        onChange={(e) => props.onInputChange(e.target.value)}
      />
      <button
        onClick={() => props.onPickFiles([new File(["x"], "staged.txt")])}
      >
        stage file
      </button>
      <span data-testid="files">
        {props.pendingFiles.map((f) => f.name).join(",")}
      </span>
    </div>
  ),
}));
vi.mock("../../chat/components/ThreadPanel", () => ({
  default: (props: { parent: { message_id: number } }) => (
    <div data-testid="thread">{`thread ${props.parent.message_id}`}</div>
  ),
}));
vi.mock("../../chat/components/ChannelSettingsPanel", () => ({
  default: () => <div data-testid="settings">settings</div>,
}));

import Chat from "../../chat/Chat";
import { forgetOpenChat, rememberOpenChat } from "../../chat/openChatSession";

const Chrome = () => {
  const { pathname, search } = useLocation();
  return (
    <>
      <Link to="/chat">to chat</Link>
      <Link to="/emails">to emails</Link>
      <span data-testid="url">{pathname + search}</span>
    </>
  );
};

const renderApp = (path = "/chat") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Chrome />
      <Routes>
        <Route path="/chat" element={<Chat />} />
        <Route path="/emails" element={<div>emails page</div>} />
      </Routes>
    </MemoryRouter>
  );

const url = () => screen.getByTestId("url").textContent;
const title = () => screen.getByTestId("title").textContent;
const expectTitle = (text: string) =>
  waitFor(() => expect(title()).toContain(text));
const list = () => document.querySelector(".messages") as HTMLDivElement;

const leaveAndReturn = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText("to emails"));
  await screen.findByText("emails page");
  await user.click(screen.getByText("to chat"));
};

const channel = {
  id: 9,
  name: "general",
  visibility: "public",
  is_member: true,
  member_emails: [],
  member_ids: [1],
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  forgetOpenChat();
  h.userId = 1;
  h.users = [
    { id: 5, email: "five@test.local" },
    { id: 6, email: "six@test.local" },
  ];
  h.channels = [channel];
  api.getChatMessages.mockReset().mockResolvedValue([]);
  api.getChannelMessages.mockReset().mockResolvedValue([
    {
      message_id: 40,
      sender_id: 2,
      content: "parent",
      status: "sent",
      created_at: "2026-01-01T00:00:00Z",
    },
  ]);
  api.getChannelThread.mockReset().mockResolvedValue([]);
  api.findChatUserByEmail.mockReset().mockResolvedValue(null);
});

describe("chat window keep-open", () => {
  it("reopens the same DM when coming back through the sidebar link", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("pick five@test.local"));
    await expectTitle("five@test.local");

    await leaveAndReturn(user);

    await expectTitle("five@test.local");
    await waitFor(() => expect(url()).toBe("/chat?dm=5"));
  });

  it("restores the thread, settings panel and scroll position", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("pick general"));
    await expectTitle("general");
    await user.click(screen.getByText("toggle settings"));
    await screen.findByTestId("settings");
    list().scrollTop = 120;
    list().dispatchEvent(new Event("scroll", { bubbles: true }));
    await user.click(screen.getByLabelText("Reply in thread"));
    await screen.findByTestId("thread");

    await leaveAndReturn(user);

    expect(await screen.findByTestId("thread")).toHaveTextContent("thread 40");
    await screen.findByTestId("settings");
    expect(list().scrollTop).toBe(120);
  });

  it("restores the draft and staged files without storing the text", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("pick five@test.local"));
    await expectTitle("five@test.local");
    await user.type(screen.getByLabelText("draft"), "secret words");
    await user.click(screen.getByText("stage file"));

    expect(JSON.stringify({ ...sessionStorage })).not.toContain("secret");

    await leaveAndReturn(user);

    await expectTitle("five@test.local");
    expect(screen.getByLabelText("draft")).toHaveValue("secret words");
    await waitFor(() =>
      expect(screen.getByTestId("files")).toHaveTextContent("staged.txt")
    );
  });

  it("doesn't reopen a conversation closed on purpose", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("pick five@test.local"));
    await expectTitle("five@test.local");
    await user.click(screen.getByText("close chat"));
    await waitFor(() => expect(url()).toBe("/chat"));

    await leaveAndReturn(user);

    await screen.findByText("pick five@test.local");
    expect(title()).toBe("Select a conversation");
    expect(url()).toBe("/chat");
  });

  it("doesn't bring the saved one back after another is opened and closed", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("pick five@test.local"));
    await expectTitle("five@test.local");
    await leaveAndReturn(user);
    await expectTitle("five@test.local");

    await user.click(screen.getByText("pick six@test.local"));
    await expectTitle("six@test.local");
    await user.click(screen.getByText("close chat"));
    await waitFor(() => expect(url()).toBe("/chat"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(title()).toBe("Select a conversation");
  });

  it("opens the URL's conversation over the saved one", async () => {
    rememberOpenChat({
      userId: 1,
      key: "dm:5",
      email: "five@test.local",
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    renderApp("/chat?dm=6");
    await expectTitle("six@test.local");
  });

  it("looks a DM peer outside the directory back up by email", async () => {
    rememberOpenChat({
      userId: 1,
      key: "dm:77",
      email: "outside@test.local",
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    api.findChatUserByEmail.mockResolvedValue({
      id: 77,
      email: "outside@test.local",
    });
    renderApp();
    await expectTitle("outside@test.local");
    expect(api.findChatUserByEmail).toHaveBeenCalledWith("outside@test.local");
  });

  it("forgets a saved conversation that no longer exists", async () => {
    rememberOpenChat({
      userId: 1,
      key: "c:404",
      email: null,
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    renderApp("/chat?c=404");
    await waitFor(() => expect(url()).toBe("/chat"));
    expect(sessionStorage.getItem("rwayve.chat.open")).toBeNull();
    expect(title()).toBe("Select a conversation");
  });

  it("keeps the saved conversation when the lookup fails", async () => {
    rememberOpenChat({
      userId: 1,
      key: "dm:77",
      email: "outside@test.local",
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    api.findChatUserByEmail.mockRejectedValue(new Error("offline"));
    renderApp();
    await waitFor(() => expect(api.findChatUserByEmail).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionStorage.getItem("rwayve.chat.open")).not.toBeNull();
  });

  it("ignores another user's saved conversation", async () => {
    rememberOpenChat({
      userId: 2,
      key: "dm:5",
      email: "five@test.local",
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    renderApp();
    await screen.findByText("pick five@test.local");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(title()).toBe("Select a conversation");
  });

  it("leaves the URL alone when rendered in a pane on another page", async () => {
    rememberOpenChat({
      userId: 1,
      key: "dm:5",
      email: "five@test.local",
      threadParentId: null,
      settingsOpen: false,
      scrollTop: 0,
    });
    render(
      <MemoryRouter initialEntries={["/emails?dm=6"]}>
        <Chrome />
        <Chat />
      </MemoryRouter>
    );
    await expectTitle("five@test.local");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(url()).toBe("/emails?dm=6");
  });
});
