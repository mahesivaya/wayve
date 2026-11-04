// Creating a team from the sidebar's ＋ opens the new team's page, instead of
// leaving the owner on whatever page they were on. The Teams section itself only
// shows in admin mode.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const session = vi.hoisted(() => ({
  mode: "admin" as "admin" | "normal",
  organizationId: 1,
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
      mode: session.mode,
      organization_id: session.organizationId,
      can_switch_admin: true,
      permissions: [],
    },
    logout: vi.fn(),
  }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: () => true,
  canViewIntegrations: () => true,
}));
vi.mock("../../api/activity", () => ({ recordActivity: vi.fn() }));
const createTeam = vi.fn();
const listTeams = vi.hoisted(() => vi.fn());
vi.mock("../../api/workspace", () => ({
  listTeams,
  createTeam: (input: { name: string }) => createTeam(input),
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

function CurrentPath() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

describe("Layout team creation", () => {
  beforeEach(() => {
    session.mode = "admin";
    session.organizationId = 1;
    listTeams.mockReset();
    listTeams.mockResolvedValue([]);
  });

  it("navigates to the team it just created", async () => {
    createTeam.mockResolvedValue({
      id: 7,
      name: "Platform",
      slug: "platform",
      tagline: null,
      description: null,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/teams/engineering"]}>
        <Layout>
          <Routes>
            <Route path="*" element={<CurrentPath />} />
          </Routes>
        </Layout>
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "New Teams" }));
    await user.type(
      screen.getByRole("textbox", { name: "New team name" }),
      "Platform{Enter}"
    );

    expect(createTeam).toHaveBeenCalledWith({ name: "Platform" });
    expect((await screen.findByText("/teams/platform")).textContent).toBe(
      "/teams/platform"
    );
  });

  it("lists no invented teams for an org that has none", async () => {
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <Routes>
            <Route path="*" element={<CurrentPath />} />
          </Routes>
        </Layout>
      </MemoryRouter>
    );

    expect(await screen.findByText("No teams yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Engineering" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Finance" })).toBeNull();
  });

  // Upgrading keeps the same user, so the user id alone wouldn't refetch.
  it("loads the default team when the user joins an organization", async () => {
    const layout = () => (
      <MemoryRouter initialEntries={["/home"]}>
        <Layout>
          <Routes>
            <Route path="*" element={<CurrentPath />} />
          </Routes>
        </Layout>
      </MemoryRouter>
    );
    const { rerender } = render(layout());
    expect(await screen.findByText("No teams yet")).toBeTruthy();

    listTeams.mockResolvedValue([
      {
        id: 9,
        name: "Acme",
        slug: "acme",
        tagline: null,
        description: null,
      },
    ]);
    session.organizationId = 5;
    rerender(layout());

    expect(await screen.findByRole("link", { name: "Acme" })).toBeTruthy();
    expect(screen.queryByText("No teams yet")).toBeNull();
  });

  it("shows the Teams section in admin mode only", () => {
    const renderLayout = () =>
      render(
        <MemoryRouter initialEntries={["/home"]}>
          <Layout>
            <Routes>
              <Route path="*" element={<CurrentPath />} />
            </Routes>
          </Layout>
        </MemoryRouter>
      );

    const admin = renderLayout();
    expect(screen.getByText("Teams")).toBeTruthy();
    admin.unmount();

    session.mode = "normal";
    renderLayout();
    expect(screen.queryByText("Teams")).toBeNull();
  });
});
