// One pane per app. Opening an app from the sidebar that another pane already
// shows used to load a second copy (two Chat panes side by side, each with its
// own socket). Now the pane already showing it is focused and pulses instead,
// and the layout never holds the same app twice. Drives the real sidebar links
// and split control; the page modules are stubbed so only Layout is under test.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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

vi.mock("../../notes/Notes", () => ({ default: () => <div>notes page</div> }));
vi.mock("../../home/Home", () => ({ default: () => <div>home page</div> }));

import Layout from "../../components/Layout";

const paneTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".split-pane-title")).map(
    (el) => el.textContent?.trim() ?? ""
  );

describe("Layout keeps one pane per app", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("focuses the pane already showing an app instead of opening it twice", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <div data-testid="routed">routed page</div>
        </Layout>
      </MemoryRouter>
    );

    // Open the second column (it starts on Home and takes focus), then load
    // Notes into it from the sidebar.
    await user.click(screen.getByRole("button", { name: "Split view" }));
    await user.click(
      screen.getByRole("menuitem", { name: /Split vertically/ })
    );
    await user.click(screen.getByRole("link", { name: "Notes" }));
    expect(paneTitles(container)).toEqual(["Home", "Notes"]);

    // Focus the left pane, then ask for Notes again. Before the fix the left
    // pane navigated to Notes too: two Notes panes.
    await user.click(screen.getByTestId("routed"));
    await user.click(screen.getByRole("link", { name: "Notes" }));

    expect(paneTitles(container)).toEqual(["Home", "Notes"]);
    const right = container.querySelector(".split-pane.right");
    expect(right?.className).toContain("active-target");
    expect(right?.className).toMatch(/pane-flash--[01]/);
  });
});
