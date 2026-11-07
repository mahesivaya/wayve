// DMs across scopes are refused by the server (only platform support may talk
// to personal accounts and organization admins). The client must say so: the
// start-chat form before a conversation opens, and the socket hook when a send
// is refused, so a message never looks sent and then vanishes on refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useChatSocket } from "../../chat/hooks/useChatSocket";
import StartChatForm from "../../chat/components/StartChatForm";

const findChatUserByEmail = vi.fn();
vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  findChatUserByEmail: (...args: unknown[]) => findChatUserByEmail(...args),
}));

describe("StartChatForm", () => {
  it("refuses someone the scope rules don't allow", async () => {
    findChatUserByEmail.mockResolvedValue({
      id: 2,
      email: "staff@platform.test",
      can_message: false,
    });
    const onFound = vi.fn();
    render(
      <StartChatForm
        myUserId={1}
        users={[]}
        onFound={onFound}
        onCancel={vi.fn()}
      />
    );

    await userEvent.type(
      screen.getByPlaceholderText("name@example.com"),
      "staff@platform.test"
    );
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));

    expect(await screen.findByText(/can't message this person/)).toBeTruthy();
    expect(onFound).not.toHaveBeenCalled();
  });

  it("opens the chat when messaging is allowed", async () => {
    findChatUserByEmail.mockResolvedValue({
      id: 3,
      email: "support@platform.test",
      can_message: true,
    });
    const onFound = vi.fn();
    render(
      <StartChatForm
        myUserId={1}
        users={[]}
        onFound={onFound}
        onCancel={vi.fn()}
      />
    );

    await userEvent.type(
      screen.getByPlaceholderText("name@example.com"),
      "support@platform.test"
    );
    await userEvent.click(screen.getByRole("button", { name: "Start chat" }));

    expect(onFound).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, can_message: true })
    );
  });
});

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

describe("useChatSocket send_failed", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a refused send and never treats it as a message", () => {
    const onMessage = vi.fn();
    const onSendFailed = vi.fn();
    renderHook(() =>
      useChatSocket(
        { id: 1 },
        { current: { type: "user", user: { id: 2, email: "x@y.test" } } },
        onMessage,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onSendFailed
      )
    );
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "send_failed",
          client_id: "abc",
          receiver_id: 2,
          message: "You can't message this person.",
        }),
      });
    });

    expect(onSendFailed).toHaveBeenCalledWith(
      "abc",
      "You can't message this person."
    );
    expect(onMessage).not.toHaveBeenCalled();
  });
});
