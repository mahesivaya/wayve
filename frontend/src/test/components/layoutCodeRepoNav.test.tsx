// Code Repo in the sidebar. For personal accounts it is opt-in: hidden by
// default and added (or removed again) from the sidebar's "Add" list. Workspace
// (organization / platform) accounts keep it in their Workspace section.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Layout pulls in a lot of the app shell. None of it is what's under test, so
// each dependency is stubbed down to the shape Layout actually consumes.
// Mutable so each test can pick the account type.
const authState = {
  user: {
    id: 1,
    email: "u@test.local",
    account_type: "personal",
    effective_role: "owner",
  } as Record<string, unknown>,
};
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: authState.user, logout: vi.fn() }),
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

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <Layout>
        <div>page</div>
      </Layout>
    </MemoryRouter>
  );

describe("Code Repo sidebar entry", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is hidden for personal accounts until added from the Add list", async () => {
    authState.user = {
      id: 1,
      email: "u@test.local",
      account_type: "personal",
      effective_role: "owner",
    };
    const user = userEvent.setup();
    renderLayout();

    expect(screen.queryByRole("link", { name: "Code Repo" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Code Repo/ }));

    expect(screen.getByRole("link", { name: "Code Repo" })).toBeTruthy();
    // The choice is remembered for this browser.
    expect(window.localStorage.getItem("rwayve.layout.personalApps")).toContain(
      "github"
    );
  });

  it("stays in the Workspace section for organization accounts", async () => {
    authState.user = {
      id: 2,
      email: "o@test.local",
      account_type: "organization",
      scope: "organization",
      effective_role: "owner",
      organization_id: 9,
    };
    const user = userEvent.setup();
    renderLayout();
    // No personal "Add" list for workspace accounts.
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    // Code Repo lives inside the Workspace section; open it if collapsed.
    const workspace = screen.getByRole("button", { name: /Workspace/ });
    if (workspace.getAttribute("aria-expanded") !== "true") {
      await user.click(workspace);
    }
    expect(screen.getByRole("link", { name: /Code Repo/ })).toBeTruthy();
  });
});
