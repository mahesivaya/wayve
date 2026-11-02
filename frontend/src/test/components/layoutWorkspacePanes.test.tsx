// Workspace sidebar items follow the active pane. Library, User Stories, Tickets
// and Skills were plain links, so with the second pane focused a click still
// navigated and replaced the routed first pane. Drives the real sidebar on both
// admin homes; the page modules are stubbed so only Layout is under test.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

// Layout pulls in a lot of the app shell. None of it is what's under test, so
// each dependency is stubbed down to the shape Layout actually consumes.
// Mutable so each test can pick the account.
const authState = { user: {} as Record<string, unknown> };
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: authState.user, logout: vi.fn() }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: () => true,
  canViewIntegrations: () => true,
}));
vi.mock("../../api/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("../../api/featureAccess", () => ({
  getFeatureAccess: vi.fn().mockResolvedValue({ features: [] }),
}));
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

vi.mock("../../home/Home", () => ({
  default: () => <div data-testid="pane-home">home page</div>,
}));
vi.mock("../../notes/Notes", () => ({ default: () => <div>notes page</div> }));
vi.mock("../../documents/DocumentsBox", () => ({
  default: () => <div>library page</div>,
}));
vi.mock("../../userstories/UserStories", () => ({
  default: () => <div>stories page</div>,
}));
vi.mock("../../tickets/Tickets", () => ({
  default: () => <div>tickets page</div>,
}));
vi.mock("../../skills/SkillsBox", () => ({
  default: () => <div>skills page</div>,
}));
vi.mock("../../github/GitHubRepo", () => ({
  default: () => <div>repo page</div>,
}));
vi.mock("../../requests/RequestsPage", () => ({
  default: () => <div>requests page</div>,
}));

import Layout from "../../components/Layout";

const ACCOUNTS = [
  {
    name: "enterprise",
    home: "/organization/home",
    user: {
      id: 1,
      email: "o@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
      organization_id: 9,
      mode: "admin",
    },
  },
  {
    name: "platform",
    home: "/platform/home",
    user: {
      id: 2,
      email: "p@test.local",
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "owner",
      mode: "admin",
    },
  },
];

const WORKSPACE_ITEMS = [
  {
    link: "Library",
    page: "library page",
    title: "Library",
    path: "/documents",
  },
  {
    link: "User Stories",
    page: "stories page",
    title: "User Stories",
    path: "/user-stories",
  },
  { link: "Tickets", page: "tickets page", title: "Tickets", path: "/tickets" },
  { link: "Skills", page: "skills page", title: "Skills", path: "/skills" },
  { link: "Code Repo", page: "repo page", title: "GitHub", path: "/github" },
  {
    link: "Requests",
    page: "requests page",
    title: "Requests",
    path: "/requests",
  },
];

const RoutedPage = () => (
  <div data-testid="routed">{useLocation().pathname}</div>
);

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <RoutedPage />
      </Layout>
    </MemoryRouter>
  );

const paneTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".split-pane-title")).map(
    (el) => el.textContent?.trim() ?? ""
  );

const persistSplit = (rightView: string, splitTarget: "left" | "right") =>
  window.localStorage.setItem(
    "rwayve.layout.split",
    JSON.stringify({ rightView, splitTarget })
  );

describe.each(ACCOUNTS)("Workspace items on the $name home", (account) => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.user = account.user;
  });

  it.each(WORKSPACE_ITEMS)(
    "$link opens in the second pane when it is active",
    async ({ link, page, title }) => {
      const user = userEvent.setup();
      const { container } = renderAt(account.home);

      await user.click(screen.getByRole("button", { name: "Split view" }));
      await user.click(
        screen.getByRole("menuitem", { name: /Split vertically/ })
      );
      // Click inside the second pane, exactly as a user would to activate it.
      await user.click(await screen.findByTestId("pane-home"));
      await user.click(screen.getByRole("link", { name: new RegExp(link) }));

      expect(await screen.findByText(page)).toBeTruthy();
      expect(paneTitles(container)).toEqual(["Home", title]);
      // The routed first pane never moved.
      expect(screen.getByTestId("routed").textContent).toBe(account.home);
      expect(
        screen.getByRole("link", { name: new RegExp(link) }).className
      ).toContain("active-split");
    }
  );

  it.each(WORKSPACE_ITEMS)(
    "$link navigates the first pane when it is active",
    async ({ link, path }) => {
      const user = userEvent.setup();
      persistSplit("notes", "left");
      renderAt(account.home);

      await user.click(screen.getByRole("link", { name: new RegExp(link) }));

      expect(screen.getByTestId("routed").textContent).toBe(path);
    }
  );

  it.each(WORKSPACE_ITEMS)(
    "$link navigates normally with no split open",
    async ({ link, path }) => {
      const user = userEvent.setup();
      renderAt(account.home);

      await user.click(screen.getByRole("link", { name: new RegExp(link) }));

      expect(screen.getByTestId("routed").textContent).toBe(path);
    }
  );

  it("focuses the pane already showing an item instead of closing the split", async () => {
    const user = userEvent.setup();
    // With the first pane active, this click used to navigate there too, and
    // the duplicate check then closed the second pane.
    persistSplit("tickets", "left");
    const { container } = renderAt(account.home);

    await user.click(screen.getByRole("link", { name: /Tickets/ }));

    expect(paneTitles(container)).toEqual(["Home", "Tickets"]);
    expect(screen.getByTestId("routed").textContent).toBe(account.home);
    const right = container.querySelector(".split-pane.right");
    expect(right?.className).toContain("active-target");
    expect(right?.className).toMatch(/pane-flash--[01]/);
  });
});
