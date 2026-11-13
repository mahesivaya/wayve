// Wide screens: the Platform pages (reached from the Settings gear's "Platform
// admin" item) swap the sidebar's menu for the Platform menu, like Settings,
// and the main menu has no Platform group.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Layout pulls in a lot of the app shell. None of it is what's under test, so
// each dependency is stubbed down to the shape Layout actually consumes.
// Mutable so each test can pick the account type.
const PLATFORM_ADMIN = {
  id: 1,
  email: "owner@test.local",
  account_type: "platform_admin",
  scope: "platform",
  effective_role: "owner",
};
const authState = { user: { ...PLATFORM_ADMIN } as Record<string, unknown> };
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: authState.user, logout: vi.fn() }),
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
// Shows which Platform admin target Layout hands the Settings gear menu.
vi.mock("../../components/ProfileMenu", () => ({
  default: ({ platformAdminPath }: { platformAdminPath?: string }) => (
    <div data-testid="gear-platform-admin">{platformAdminPath ?? "none"}</div>
  ),
}));

import Layout from "../../components/Layout";

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <div>page</div>
      </Layout>
    </MemoryRouter>
  );

describe("Platform admin sidebar menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.user = { ...PLATFORM_ADMIN };
  });

  it("swaps the sidebar for the Platform menu on a Platform page", () => {
    renderAt("/platform/members");
    expect(screen.getByRole("link", { name: "Back to Home" })).toBeTruthy();
    const members = screen.getByRole("link", { name: "Members & roles" });
    expect(members.className).toContain("active");
    expect(screen.getByRole("link", { name: "Analytics" })).toBeTruthy();
    // The main menu is swapped out, as on the settings pages.
    expect(screen.queryByRole("link", { name: "Inbox" })).toBeNull();
  });

  it("keeps the main menu elsewhere, without a Platform group", () => {
    renderAt("/home");
    expect(screen.getByRole("link", { name: "Inbox" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Members & roles" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Back to Home" })).toBeNull();
  });

  it("offers Platform admin in the gear menu to a platform admin", () => {
    renderAt("/home");
    expect(screen.getByTestId("gear-platform-admin").textContent).toBe(
      "/platform/members"
    );
  });

  it("gives everyone else no Platform admin item or menu", () => {
    authState.user = {
      id: 2,
      email: "org@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
    };
    renderAt("/platform/members");
    expect(screen.getByTestId("gear-platform-admin").textContent).toBe("none");
    expect(screen.queryByRole("link", { name: "Back to Home" })).toBeNull();
  });
});
