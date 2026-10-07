// Creating a team from the sidebar's ＋ opens the new team's page, instead of
// leaving the owner on whatever page they were on (often a sample team, which
// looked like "it opened another team").
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
      mode: "admin",
      can_switch_admin: true,
      permissions: [],
    },
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
const createTeam = vi.fn();
vi.mock("../../api/workspace", () => ({
  listTeams: vi.fn().mockResolvedValue([]),
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
});
