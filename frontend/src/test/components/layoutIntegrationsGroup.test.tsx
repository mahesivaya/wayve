// The sidebar's Integrations group lists live connections only.
//
// The rule that matters: what appears comes from the server's connection
// status, not from the catalog of services the account is *allowed* to connect.
// Listing an unconnected service there would claim a link works when clicking
// it only lands on a Connect button.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

const getConnectedIntegrations = vi.fn();
vi.mock("../../api/integrations", () => ({
  getConnectedIntegrations: () => getConnectedIntegrations(),
}));

import Layout from "../../components/Layout";

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <Layout>
        <div />
      </Layout>
    </MemoryRouter>
  );

describe("sidebar Integrations group", () => {
  beforeEach(() => {
    window.localStorage.clear();
    getConnectedIntegrations.mockReset();
  });

  it("lists only connected services, expanded by default", async () => {
    getConnectedIntegrations.mockResolvedValue({
      connected: ["github", "figma"],
    });
    renderLayout();

    expect(
      await screen.findByRole("link", { name: "GitHub" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Figma" })).toBeInTheDocument();
    // Expanded without a click — the group's whole job is showing this at a
    // glance.
    expect(
      screen.getByRole("button", { name: /Integrations/ })
    ).toHaveAttribute("aria-expanded", "true");

    // Connectable but not connected: must not be listed.
    expect(screen.queryByRole("link", { name: "Jira" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Slack" })).toBeNull();
    expect(screen.queryByRole("link", { name: "GitLab" })).toBeNull();
  });

  it("offers a way in when nothing is connected", async () => {
    getConnectedIntegrations.mockResolvedValue({ connected: [] });
    renderLayout();

    expect(
      await screen.findByRole("link", { name: "Connect a service" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull();
  });

  it("lists nothing when the status call fails", async () => {
    getConnectedIntegrations.mockRejectedValue(new Error("offline"));
    renderLayout();

    // Same empty-state row, and no invented connections.
    expect(
      await screen.findByRole("link", { name: "Connect a service" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull();
  });
});
