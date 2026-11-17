// A basic personal user's Upgrade button sits at the end of the tab strip. Once
// the page is split that strip ends mid-screen, so the button moves to the
// sidebar, above the account row.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PaneRoutesContext } from "../../components/tabs/paneContexts";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "u@test.local", account_type: "personal" },
    logout: vi.fn(),
  }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: () => true,
  canViewIntegrations: () => true,
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

const renderRoutes = (location?: string) => (
  <p data-testid="pane-page">{location ?? "main"}</p>
);

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <PaneRoutesContext.Provider value={renderRoutes}>
        <Layout>
          <p>page</p>
        </Layout>
      </PaneRoutesContext.Provider>
    </MemoryRouter>
  );

const upgrade = () => screen.getByRole("button", { name: "Upgrade" });

describe("the Upgrade button's place", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is at the end of the tab strip while the page is unsplit", () => {
    const { container } = renderLayout();
    expect(container.querySelector(".split-pane.right")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Upgrade" })).toHaveLength(1);
    expect(upgrade().closest(".sidebar-section-bottom")).toBeNull();
    expect(upgrade().classList.contains("sidebar-upgrade-btn")).toBe(false);
  });

  it("moves to the bottom of the sidebar once the page is split", () => {
    window.localStorage.setItem(
      "rwayve.layout.split",
      JSON.stringify({ rightView: "tasks", splitTarget: "left" })
    );
    const { container } = renderLayout();
    expect(container.querySelector(".split-pane.right")).toBeTruthy();
    // One button only: it left the tab strip rather than being duplicated.
    expect(screen.getAllByRole("button", { name: "Upgrade" })).toHaveLength(1);
    expect(upgrade().closest(".sidebar-section-bottom")).toBeTruthy();
  });
});
