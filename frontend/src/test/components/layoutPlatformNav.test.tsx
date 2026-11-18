// Wide screens: the Platform pages are listed in the settings menu, under
// Administration, and opening one keeps that menu in the sidebar. The main
// menu has no Platform group, and the account menu no Platform admin item.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
vi.mock("../../components/ProfileMenu", () => ({ default: () => null }));

import Layout from "../../components/Layout";

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <div>page</div>
      </Layout>
    </MemoryRouter>
  );

describe("Platform pages in the settings menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.user = { ...PLATFORM_ADMIN };
  });

  const administrationLabels = () => {
    const heading = screen.getByText("Administration");
    const section = heading.closest(".sidebar-section");
    if (!(section instanceof HTMLElement)) throw new Error("no section");
    return within(section)
      .getAllByRole("link")
      .map((l) => l.textContent);
  };

  it("lists every Platform page under Administration on Settings", () => {
    renderAt("/settings");
    expect(administrationLabels()).toEqual([
      "Teams",
      "Projects",
      "AI",
      "Usage",
      "Members & roles",
      "Personal accounts",
      "Billing",
      "Developer",
      "Support",
      "Secrets",
      "Feature Access",
      "Analytics",
    ]);
  });

  it("keeps the settings menu on a Platform page, with its link lit", () => {
    renderAt("/platform/members");
    expect(screen.getByRole("link", { name: "Back to Home" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "General" })).toBeTruthy();
    const members = screen.getByRole("link", { name: "Members & roles" });
    expect(members.className).toContain("active");
    expect(
      screen.getByRole("link", { name: "Analytics" }).className
    ).not.toContain("active");
    // The main menu is swapped out, as on the settings pages.
    expect(screen.queryByRole("link", { name: "Inbox" })).toBeNull();
  });

  it("keeps the main menu elsewhere, without a Platform group", () => {
    renderAt("/home");
    expect(screen.getByRole("link", { name: "Inbox" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Members & roles" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Back to Home" })).toBeNull();
  });

  it("gives everyone else no Platform pages", () => {
    authState.user = {
      id: 2,
      email: "org@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
    };
    renderAt("/settings");
    expect(administrationLabels()).not.toContain("Members & roles");
    expect(screen.queryByRole("link", { name: "Secrets" })).toBeNull();
  });

  it("does not swap the menu on a Platform page for anyone else", () => {
    authState.user = {
      id: 2,
      email: "org@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
    };
    renderAt("/platform/members");
    expect(screen.queryByRole("link", { name: "Back to Home" })).toBeNull();
  });
});
