// The sidebar's Projects section, below Teams: it lists the Projects page's
// repositories, loaded when the section is first opened.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const session = vi.hoisted(() => ({
  mode: "admin" as "admin" | "normal",
  organizationId: 1,
  scope: "organization" as "organization" | "platform" | "personal",
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@test.local",
      account_type:
        session.scope === "personal" ? "personal" : "organization_admin",
      scope: session.scope,
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
const getVisibleProjects = vi.hoisted(() => vi.fn());
vi.mock("../../api/github", () => ({ getVisibleProjects }));
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

const repo = (name: string) => ({
  name,
  full_name: `acme/${name}`,
  owner: { login: "acme" },
  private: true,
  description: null,
});

function renderLayout() {
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <Layout>
        <Routes>
          <Route path="*" element={<CurrentPath />} />
        </Routes>
      </Layout>
    </MemoryRouter>
  );
}

describe("Layout Projects section", () => {
  beforeEach(() => {
    session.mode = "admin";
    session.organizationId = 1;
    session.scope = "organization";
    listTeams.mockReset();
    listTeams.mockResolvedValue([]);
    getVisibleProjects.mockReset();
    getVisibleProjects.mockResolvedValue({ unrestricted: true, repos: [] });
  });

  it("sits below Teams and loads its projects only once opened", async () => {
    getVisibleProjects.mockResolvedValue({
      unrestricted: true,
      repos: [repo("api"), repo("web")],
    });
    const user = userEvent.setup();
    renderLayout();

    const teams = screen.getByRole("button", { name: "Teams" });
    const projects = screen.getByRole("button", { name: "Projects" });
    expect(
      teams.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Collapsed to start with: nothing is fetched until it is opened.
    expect(projects.getAttribute("aria-expanded")).toBe("false");
    expect(getVisibleProjects).not.toHaveBeenCalled();

    await user.click(projects);
    expect(await screen.findByRole("link", { name: "api" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "web" }));
    expect(screen.getByTestId("path").textContent).toBe("/projects/acme/web");

    // Closing and reopening reuses the loaded list.
    await user.click(projects);
    await user.click(projects);
    expect(getVisibleProjects).toHaveBeenCalledTimes(1);
  });

  it("shows for platform accounts but never for personal ones", () => {
    session.scope = "platform";
    renderLayout();
    expect(screen.getByRole("button", { name: "Projects" })).toBeTruthy();
    cleanup();

    getVisibleProjects.mockClear();
    session.scope = "personal";
    renderLayout();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    // Not even fetched, though the section was left open above.
    expect(getVisibleProjects).not.toHaveBeenCalled();
  });

  it("says so when there are no projects", async () => {
    getVisibleProjects.mockResolvedValue({ unrestricted: true, repos: [] });
    const user = userEvent.setup();
    renderLayout();

    // Section open state outlives a Layout instance, so the test above may
    // have left it open.
    const projects = screen.getByRole("button", { name: "Projects" });
    if (projects.getAttribute("aria-expanded") !== "true") {
      await user.click(projects);
    }
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });
});
