// The app-wide new-message cards: shown bottom-right on other pages, silent while
// a Chat view is open or under Do Not Disturb, click-through to the chat, and an
// inline reply box that sends straight back.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../api/chat";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1 } }),
}));

vi.mock("../../api/chat", () => ({
  getChatUsers: vi.fn(async () => [{ id: 7, email: "ana@example.com" }]),
  getChatChannels: vi.fn(async () => [
    { id: 3, name: "design", member_ids: [1, 7] },
  ]),
  getPresence: vi.fn(async () => []),
  getChatMessages: vi.fn(async () => [
    {
      message_id: 50,
      sender_id: 1,
      receiver_id: 7,
      content: "Are you around?",
      status: "read",
      created_at: "",
    },
    {
      message_id: 51,
      sender_id: 7,
      receiver_id: 1,
      content: "Lunch at noon?",
      status: "sent",
      created_at: "",
    },
  ]),
  getChannelMessages: vi.fn(async () => [
    {
      message_id: 60,
      sender_id: 7,
      channel_id: 3,
      sender_name: "Ana",
      content: "shipped",
      status: "sent",
      created_at: "",
    },
  ]),
}));

vi.mock("../../crypto/keyStore", () => ({
  loadPrivateKey: vi.fn(async () => null),
}));

// Replies are encrypted by the shared helper; here it just tags the text.
vi.mock("../../chat/outgoing", () => ({
  encryptTextForSend: vi.fn(
    async (_u: unknown, _c: unknown, _d: unknown, t: string) => `ENC:${t}`
  ),
}));

// Capture what the popup host hands the socket, so a test can "receive" frames
// and see what it sends.
const socket = vi.hoisted(() => ({
  user: null as { id: number } | null | undefined,
  onInbound: undefined as ((m: ChatMessage) => void) | undefined,
  onSendFailed: undefined as
    ((clientId: string, reason: string) => void) | undefined,
  ws: { readyState: 1, send: (_frame: string) => {} },
}));
vi.mock("../../chat/hooks/useChatSocket", () => ({
  useChatSocket: (
    user: { id: number } | null | undefined,
    _sel: unknown,
    _onMessage: unknown,
    _onOpen: unknown,
    _onStatus: unknown,
    onInbound: (m: ChatMessage) => void,
    _onPresence: unknown,
    _onReaction: unknown,
    onSendFailed: (clientId: string, reason: string) => void
  ) => {
    socket.user = user;
    socket.onInbound = onInbound;
    socket.onSendFailed = onSendFailed;
    return {
      wsRef: { current: socket.ws },
      isConnected: true,
      isReconnecting: false,
    };
  },
}));

import ChatPopups from "../../components/ChatPopups";
import { markChatOpen } from "../../chat/chatOpenRegistry";
import { applyMyStatus, resetMyStatusForTests } from "../../chat/myStatus";
import { messagePreview } from "../../chat/messagePreview";

const dm = (content: string, sender = 7): ChatMessage => ({
  sender_id: sender,
  receiver_id: 1,
  content,
  status: "sent",
  created_at: new Date().toISOString(),
});

function renderHost() {
  return render(
    <MemoryRouter initialEntries={["/emails"]}>
      <ChatPopups />
      <Routes>
        <Route path="/emails" element={<p>emails page</p>} />
        <Route path="/chat" element={<p>chat page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const receive = async (m: ChatMessage) => {
  await act(async () => {
    socket.onInbound?.(m);
  });
};

describe("ChatPopups", () => {
  beforeEach(() => {
    resetMyStatusForTests();
    socket.user = null;
    socket.onInbound = undefined;
    socket.ws.send = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a DM with the sender and text", async () => {
    renderHost();
    expect(socket.user).toEqual({ id: 1 });
    await receive(dm("Lunch at noon?"));
    expect(await screen.findByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText("Lunch at noon?")).toBeInTheDocument();
  });

  it("groups a burst from one person into one card", async () => {
    renderHost();
    await receive(dm("one"));
    await receive(dm("two"));
    expect(await screen.findByText("2 new")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("titles a channel message with the channel and sender", async () => {
    renderHost();
    await receive({ ...dm("shipped"), channel_id: 3, sender_name: "Ana" });
    expect(await screen.findByText("#design")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
  });

  it("ignores my own messages and non-message frames", async () => {
    renderHost();
    await receive(dm("from me", 1));
    await receive({ ...dm("x"), type: "conversation_read" } as ChatMessage);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the conversation inside the card on click", async () => {
    renderHost();
    await receive(dm("Lunch at noon?"));
    await userEvent.click(await screen.findByText("Lunch at noon?"));
    expect(
      await screen.findByRole("dialog", {
        name: "Conversation with ana@example.com",
      })
    ).toBeInTheDocument();
    // History, oldest first, ending with the new message.
    expect(await screen.findByText("Are you around?")).toBeInTheDocument();
    expect(screen.getByText("Lunch at noon?")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply to ana@example.com")).toHaveFocus();
    expect(screen.getByText("emails page")).toBeInTheDocument();
  });

  it("goes to the full chat with the open-in-chat button", async () => {
    renderHost();
    await receive(dm("hello"));
    await userEvent.click(
      await screen.findByLabelText("Open ana@example.com in Chat")
    );
    expect(screen.getByText("chat page")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("adds new messages to an open conversation", async () => {
    renderHost();
    await receive(dm("Lunch at noon?"));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await screen.findByText("Are you around?");
    socket.ws.send = vi.fn();
    await receive(dm("I'll book a table"));
    expect(await screen.findByText("I'll book a table")).toBeInTheDocument();
    expect(screen.queryByText("2 new")).not.toBeInTheDocument();
    // Seen as it arrives, so it's marked read.
    const frames = (socket.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([f]) => JSON.parse(f as string) as Record<string, unknown>
    );
    expect(frames).toEqual([
      expect.objectContaining({ receiver_id: 7, status: "read" }),
    ]);
  });

  it("dismisses with the close button", async () => {
    renderHost();
    await receive(dm("bye"));
    await userEvent.click(
      await screen.findByLabelText("Dismiss message from ana@example.com")
    );
    expect(screen.queryByText("bye")).not.toBeInTheDocument();
  });

  it("goes away on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHost();
    await receive(dm("brief"));
    expect(await screen.findByText("brief")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(8_100);
    });
    expect(screen.queryByText("brief")).not.toBeInTheDocument();
  });

  it("stands down while a Chat view is open", async () => {
    renderHost();
    await receive(dm("seen in chat"));
    let close = () => {};
    act(() => {
      close = markChatOpen();
    });
    expect(socket.user).toBeNull();
    expect(screen.queryByText("seen in chat")).not.toBeInTheDocument();
    act(() => close());
    expect(socket.user).toEqual({ id: 1 });
  });

  it("stays quiet under Do Not Disturb", () => {
    applyMyStatus("dnd");
    renderHost();
    expect(socket.user).toBeNull();
  });
});

describe("ChatPopups reply", () => {
  beforeEach(() => {
    resetMyStatusForTests();
    socket.ws.send = vi.fn();
  });

  const sentFrames = () =>
    (socket.ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([f]) => JSON.parse(f as string) as Record<string, unknown>
    );

  it("replies to a DM from the card, marking it read", async () => {
    renderHost();
    await receive(dm("Lunch at noon?"));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await userEvent.type(
      screen.getByLabelText("Reply to ana@example.com"),
      "Sounds good{Enter}"
    );
    // The reply shows in the conversation, and the box clears for the next one.
    expect(await screen.findByText("Sounds good")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply to ana@example.com")).toHaveValue("");
    const frames = sentFrames();
    expect(frames[0]).toMatchObject({
      receiver_id: 7,
      status: "read",
      content: "",
    });
    expect(frames[1]).toMatchObject({
      sender_id: 1,
      receiver_id: 7,
      content: "ENC:Sounds good",
    });
    expect(typeof frames[1].client_id).toBe("string");
  });

  it("replies into a channel", async () => {
    renderHost();
    await receive({ ...dm("shipped"), channel_id: 3, sender_name: "Ana" });
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await userEvent.type(
      screen.getByLabelText("Reply to #design"),
      "🎉{Enter}"
    );
    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ channel_id: 3, content: "ENC:🎉" });
  });

  it("Escape closes the conversation without sending", async () => {
    renderHost();
    await receive(dm("hi"));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await userEvent.type(
      screen.getByLabelText("Reply to ana@example.com"),
      "draft{Escape}"
    );
    expect(
      screen.queryByLabelText("Reply to ana@example.com")
    ).not.toBeInTheDocument();
    expect(socket.ws.send).not.toHaveBeenCalled();
  });

  it("shows the server's refusal on the card", async () => {
    renderHost();
    await receive(dm("hi"));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await userEvent.type(
      screen.getByLabelText("Reply to ana@example.com"),
      "yo{Enter}"
    );
    const clientId = sentFrames()[1].client_id as string;
    act(() =>
      socket.onSendFailed?.(clientId, "You can't message this person.")
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can't message this person."
    );
    // The refused reply is taken back out of the conversation.
    expect(screen.queryByText("yo")).not.toBeInTheDocument();
  });

  it("keeps a card open while a reply is being typed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHost();
    await receive(dm("hold on"));
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(
      screen.getByLabelText("Reply to ana@example.com")
    ).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("messagePreview", () => {
  it("collapses whitespace and truncates long text", async () => {
    expect(await messagePreview("a\n\n  b", 1)).toBe("a b");
    const long = await messagePreview("x".repeat(300), 1);
    expect(long).toHaveLength(140);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("returns null for an envelope this device can't read", async () => {
    const env = `WAYVE_CHAT_E2E_V1\n${JSON.stringify({
      type: "wayve_chat_e2e",
      data: [1],
      iv: [1],
      keys: {},
    })}`;
    expect(await messagePreview(env, 1)).toBeNull();
  });
});
