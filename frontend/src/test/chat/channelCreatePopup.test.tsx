// "Add channel" opens the new-channel form as a popup over the chat, like the
// calendar's new-meeting form, instead of pushing a form into the sidebar.
// Drives the real page; the API, the socket and the panes around it are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const h = vi.hoisted(() => ({ accountType: "personal" }));
const createChatChannel = vi.hoisted(() => vi.fn());

vi.mock("../../api/chat", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getChatUsers: vi.fn(async () => []),
  getChatChannels: vi.fn(async () => []),
  getChatConversationSummary: vi.fn(async () => ({
    total_unread: 0,
    conversations: [],
  })),
  getChannelMessages: vi.fn(async () => []),
  createChatChannel,
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@test.local", account_type: h.accountType },
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
// The sidebar keeps only the button; the form is no longer its business.
vi.mock("../../chat/components/ConversationSidebar", () => ({
  default: (props: { onToggleCreateChannel: () => void }) => (
    <button onClick={props.onToggleCreateChannel}>Add channel</button>
  ),
}));
vi.mock("../../chat/components/ChatHeader", () => ({
  default: (props: { title: string }) => (
    <span data-testid="title">{props.title}</span>
  ),
}));
vi.mock("../../chat/components/MessageComposer", () => ({
  default: () => <div />,
}));

import Chat from "../../chat/Chat";

const renderChat = () =>
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Chat />
    </MemoryRouter>
  );
const popup = () => screen.queryByRole("dialog");
const openPopup = () => {
  fireEvent.click(screen.getByRole("button", { name: "Add channel" }));
  const dialog = popup();
  if (!dialog) throw new Error("the popup did not open");
  return within(dialog);
};

describe("creating a channel", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    h.accountType = "personal";
    createChatChannel.mockReset().mockResolvedValue({
      id: 9,
      name: "updates",
      visibility: "private",
      is_member: true,
      member_emails: [],
      member_ids: [1],
      created_at: "2026-01-01T00:00:00Z",
    });
  });
  afterEach(() => cleanup());

  it("opens a popup with the form, focused on the name", () => {
    renderChat();
    expect(popup()).toBeNull();

    const form = openPopup();
    expect(form.getByRole("heading", { name: "Create channel" })).toBeTruthy();
    const name = form.getByRole("textbox");
    expect(document.activeElement).toBe(name);
    // A personal account chooses who can join, starting on Private.
    expect(form.getByRole("radio", { name: /Private/ })).toHaveProperty(
      "checked",
      true
    );
  });

  it("creates the channel on Enter and closes", async () => {
    renderChat();
    const form = openPopup();
    const name = form.getByRole("textbox");
    fireEvent.change(name, { target: { value: "updates" } });
    fireEvent.click(form.getByRole("radio", { name: /Public/ }));
    fireEvent.submit(name.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(createChatChannel).toHaveBeenCalledWith(
        "updates",
        "user",
        [],
        "public"
      )
    );
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("throws the half-filled form away when closed", () => {
    renderChat();
    let form = openPopup();
    fireEvent.change(form.getByRole("textbox"), {
      target: { value: "half typed" },
    });
    fireEvent.click(form.getByRole("radio", { name: /Public/ }));
    fireEvent.click(form.getByRole("button", { name: "Cancel" }));
    expect(popup()).toBeNull();
    expect(createChatChannel).not.toHaveBeenCalled();

    form = openPopup();
    expect((form.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(form.getByRole("radio", { name: /Private/ })).toHaveProperty(
      "checked",
      true
    );
    // The popup's own close button does the same.
    fireEvent.click(form.getByRole("button", { name: "Close modal" }));
    expect(popup()).toBeNull();
  });

  it("keeps the popup open and shows why when creating fails", async () => {
    createChatChannel.mockRejectedValue(new Error("That name is taken"));
    renderChat();
    const form = openPopup();
    fireEvent.change(form.getByRole("textbox"), {
      target: { value: "updates" },
    });
    fireEvent.click(form.getByRole("button", { name: "Create" }));
    expect(await form.findByText("That name is taken")).toBeTruthy();
    expect(popup()).not.toBeNull();
  });

  it("offers an organization no choice of who can join", () => {
    h.accountType = "organization";
    renderChat();
    const form = openPopup();
    expect(form.queryByRole("radio")).toBeNull();
  });
});
