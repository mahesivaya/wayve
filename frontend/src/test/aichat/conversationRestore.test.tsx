// The AI chat conversation survives a refresh: it is kept in the tab's
// sessionStorage, handed back only to the user it belongs to, and gone once
// the chat is cleared.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../api/ai", () => ({
  getAiProvider: vi.fn().mockResolvedValue({ provider: null, model: null }),
  sendAiChat: vi.fn(),
}));
vi.mock("../../api/email", () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  sendEmail: vi.fn(),
}));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

let mockUser: unknown = null;
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

import AIChat from "../../aichat/AIChat";
import { sendAiChat } from "../../api/ai";

const mockSend = sendAiChat as unknown as {
  mockResolvedValue: (v: unknown) => void;
};

const ask = async (text: string) => {
  await userEvent.type(screen.getByPlaceholderText(/Message AI/), text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("AI chat conversation after a refresh", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
    mockUser = null;
  });

  it("brings back the messages and an unsent draft", async () => {
    mockUser = { id: 7, permissions: [] };
    mockSend.mockResolvedValue({
      reply: "The draft is ready below.",
      pending_actions: [
        { type: "email", to: "asha@example.com", subject: "Hello", body: "Hi" },
      ],
    });

    const first = render(<AIChat />);
    await ask("write to asha");
    expect(await screen.findByText("The draft is ready below.")).toBeTruthy();
    await waitFor(() =>
      expect(sessionStorage.getItem("wayve-ai-chat-conversation")).toContain(
        "asha@example.com"
      )
    );

    // A refresh: the page is torn down and mounted again.
    first.unmount();
    render(<AIChat />);

    expect(screen.getByText("write to asha")).toBeTruthy();
    expect(screen.getByText("The draft is ready below.")).toBeTruthy();
    expect(screen.getByDisplayValue("Hello")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm & send" })).toBeTruthy();
  });

  it("does not show one user's conversation to another", () => {
    sessionStorage.setItem(
      "wayve-ai-chat-conversation",
      JSON.stringify({
        userId: 7,
        conversation: {
          messages: [{ role: "user", content: "private question" }],
          drafts: [],
          moves: [],
        },
      })
    );
    mockUser = { id: 8, permissions: [] };

    render(<AIChat />);

    expect(screen.queryByText("private question")).toBeNull();
  });

  it("forgets the conversation when the chat is cleared", async () => {
    mockUser = { id: 7, permissions: [] };
    mockSend.mockResolvedValue({ reply: "Hello there." });

    render(<AIChat />);
    await ask("hi");
    expect(await screen.findByText("Hello there.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /clear|new/i }));

    await waitFor(() =>
      expect(sessionStorage.getItem("wayve-ai-chat-conversation")).toBeNull()
    );
  });
});
