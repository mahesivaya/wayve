// Below 768px the extra panes are hidden by CSS but kept in state. They must
// not swallow sidebar taps: with Notes in a hidden right pane, tapping Notes on
// a phone used to "focus" that invisible pane and cancel the navigation, so the
// tap did nothing. It now navigates the visible column, and the hidden pane
// is left alone for when the window widens.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("../../components/useIsNarrow", () => ({ useIsNarrow: () => true }));
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

function CurrentPath() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

describe("Layout on a narrow screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Left Home, Notes in the right column (hidden at this width), right focused.
    window.localStorage.setItem(
      "rwayve.layout.split",
      JSON.stringify({
        middleView: null,
        rightView: "notes",
        splitTarget: "right",
      })
    );
  });

  it("navigates on a sidebar tap instead of focusing a hidden pane", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <CurrentPath />
        </Layout>
      </MemoryRouter>
    );
    expect(screen.getByTestId("path")).toHaveTextContent("/home");

    await user.click(screen.getByRole("link", { name: "Notes" }));

    expect(screen.getByTestId("path")).toHaveTextContent("/notes");
    // The hidden pane survives (no duplicate clean-up while narrow).
    expect(container.querySelector(".split-pane.right")).not.toBeNull();
  });
});
