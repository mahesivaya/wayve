// Opening a split must not remount the routed page.
//
// The left pane used to render its child through two structurally different
// branches — a bare <Suspense> when unsplit, and .split-pane-body > provider >
// <Suspense> once split. Same position in the tree, different element types and
// depth, so React tore the page down and built a new one. Every page-local
// useState went with it: an in-progress AI conversation was wiped the moment you
// split the view.
//
// This test drives the real header split control and asserts a stateful child
// keeps its state. It fails (state resets to 0) against the two-branch version.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";

// Layout pulls in a lot of the app shell. None of it is what's under test, so
// each dependency is stubbed down to the shape Layout actually consumes.
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "u@test.local", account_type: "personal" },
    logout: vi.fn(),
  }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: () => true,
  canViewIntegrations: () => true,
  canViewIntegrationsNav: () => true,
}));
vi.mock("../../api/integrations", () => ({
  getConnectedIntegrations: vi.fn().mockResolvedValue({ connected: [] }),
}));
vi.mock("../../api/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("../../api/workspace", () => ({
  listTeams: vi.fn().mockResolvedValue([]),
  createTeam: vi.fn(),
}));
vi.mock("../../emails/useEmailsUnreadCount", () => ({
  useEmailsUnreadCount: () => 0,
}));
vi.mock("../../chat/useChatUnreadCount", () => ({
  useChatUnreadCount: () => 0,
}));
vi.mock("../../tickets/useTicketsOpenCount", () => ({
  useTicketsOpenCount: () => 0,
}));
vi.mock("../../userstories/useUserStoriesCount", () => ({
  useUserStoriesCount: () => 0,
}));
vi.mock("../../search/SearchProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../search/SearchBar", () => ({ default: () => null }));
vi.mock("../../components/NotificationBell", () => ({ default: () => null }));
vi.mock("../../components/ReminderPopups", () => ({ default: () => null }));
vi.mock("../../components/StorageLimitBanner", () => ({ default: () => null }));
vi.mock("../../components/ProfileMenu", () => ({ default: () => null }));

import Layout from "../../components/Layout";

// Stands in for a routed page holding local state — the AI chat's `messages`,
// an unsaved draft, a scroll position. If the page remounts, this resets to 0.
function StatefulPage() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        bump
      </button>
      <span data-testid="count">{count}</span>
    </div>
  );
}

describe("Layout split does not remount the page", () => {
  beforeEach(() => {
    // Split arrangement persists to localStorage; start every test unsplit.
    window.localStorage.clear();
  });

  it("keeps page state when a second column is opened", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <StatefulPage />
        </Layout>
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "bump" }));
    await user.click(screen.getByRole("button", { name: "bump" }));
    expect(screen.getByTestId("count")).toHaveTextContent("2");

    // The real control: header split button, then the "Split vertically" item
    // (which opens the second column — the label follows the divider's
    // orientation, not the action name).
    await user.click(screen.getByRole("button", { name: "Split view" }));
    await user.click(
      screen.getByRole("menuitem", { name: /Split vertically/ })
    );

    // The split actually opened...
    expect(
      screen.getByRole("button", { name: "Close left pane" })
    ).toBeInTheDocument();
    // ...and the page survived it.
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });

  it("keeps page state when the pane is stacked into halves", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <StatefulPage />
        </Layout>
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "bump" }));
    await user.click(screen.getByRole("button", { name: "bump" }));
    await user.click(screen.getByRole("button", { name: "bump" }));
    expect(screen.getByTestId("count")).toHaveTextContent("3");

    // "Split horizontally" stacks the focused pane top/bottom — the path that
    // used to push the page two levels deeper into a .pane-half.
    await user.click(screen.getByRole("button", { name: "Split view" }));
    await user.click(
      screen.getByRole("menuitem", { name: /Split horizontally/ })
    );

    // The stack actually formed (each half carries its own close button)...
    expect(
      screen.getAllByRole("button", { name: "Close this pane" }).length
    ).toBeGreaterThan(0);
    // ...and the page in the top half survived it.
    expect(screen.getByTestId("count")).toHaveTextContent("3");
  });
});
