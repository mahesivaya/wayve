import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// AIChat only uses useNavigate from react-router-dom.
const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../api/ai", () => ({
  getAiProvider: vi.fn(),
  sendAiChat: vi.fn(),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

// Mutable so each test picks the caller's role/tier; the real hasPermission
// runs against this shape so the gate logic is genuinely exercised.
let mockUser: unknown = null;
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

import AIChat from "../../aichat/AIChat";
import { getAiProvider } from "../../api/ai";

const mockGetProvider = getAiProvider as unknown as {
  mockResolvedValue: (v: unknown) => void;
};

describe("AIChat provider badge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockUser = null;
  });

  it("shows the resolved provider (not hard-coded Gemini) + an owner-only AI settings link", async () => {
    mockUser = {
      permissions: ["ai:manage"],
      current_plan: { tier: "enterprise" },
    };
    mockGetProvider.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet",
    });

    render(<AIChat />);

    // Badge reflects the resolved provider, not "Gemini".
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("claude-sonnet")).toBeTruthy();
    expect(screen.queryByText("Gemini")).toBeNull();

    // Enterprise owner sees the shortcut and it routes to /settings/ai.
    const settings = await screen.findByRole("button", {
      name: /ai settings/i,
    });
    await userEvent.click(settings);
    expect(mockNavigate).toHaveBeenCalledWith("/settings/ai");
  });

  it("hides the AI settings link for non-owners", async () => {
    mockUser = { permissions: [], current_plan: { tier: "enterprise" } };
    mockGetProvider.mockResolvedValue({ provider: "gemini", model: null });

    render(<AIChat />);

    expect(await screen.findByText("Gemini")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ai settings/i })).toBeNull();
  });

  it("shows the AI settings link for a platform owner (no enterprise tier)", async () => {
    mockUser = { permissions: ["ai:manage"], scope: "platform" };
    mockGetProvider.mockResolvedValue({
      provider: "openai_compatible",
      model: "gpt-4o",
    });

    render(<AIChat />);

    expect(await screen.findByText("OpenAI-compatible")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /ai settings/i })
    ).toBeTruthy();
  });
});
