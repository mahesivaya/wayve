// The Settings entry point for task statuses.
//
// Regression: this link originally lived in the permission-gated "Administration"
// card. For an org/platform owner browsing in normal session mode,
// `downscope_for_mode` demotes them to `member`, so /api/me omits
// `task_statuses:manage` and the whole card disappeared — leaving the page
// reachable only by typing the URL. The entry point must not depend on that
// permission.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigate };
});

const mockAuth: { user: Record<string, unknown> | null } = { user: null };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockAuth }));

// Settings pulls in a lot of unrelated network surface; stub it to nothing so
// this test is about the entry point only.
vi.mock("../../api/email", () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  deleteAccount: vi.fn(),
}));
vi.mock("../../api/billing", () => ({
  getSubscription: vi.fn().mockResolvedValue(null),
  listInvoices: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/profile", () => ({
  getProfile: vi.fn().mockResolvedValue({}),
  putChatEncryptFiles: vi.fn(),
  putMeetingAlertMinutes: vi.fn(),
}));
vi.mock("../../api/support", () => ({
  listMyTickets: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/admin", () => ({
  deleteMyAccount: vi.fn(),
  deleteMyOrganization: vi.fn(),
  updateMyOrganization: vi.fn(),
}));

import Settings from "../../profile/Settings";

const renderSettings = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );

describe("Task statuses entry point in Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows for a normal-mode platform owner downscoped to member", async () => {
    // Exactly what /api/me returns for a platform_admin/owner in normal mode:
    // effective_role member, and no task_statuses:manage.
    mockAuth.user = {
      id: 3,
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "member",
      mode: "normal",
      can_switch_admin: true,
      permissions: ["apps:use", "profile:manage_self"],
    };
    renderSettings();
    expect(await screen.findByText("Task statuses")).toBeTruthy();
  });

  it("shows for a plain personal account with no admin permissions", async () => {
    mockAuth.user = {
      id: 9,
      account_type: "personal",
      scope: "personal",
      effective_role: "owner",
      permissions: ["apps:use", "profile:manage_self"],
    };
    renderSettings();
    expect(await screen.findByText("Task statuses")).toBeTruthy();
  });

  it("navigates to /settings/statuses when opened", async () => {
    mockAuth.user = {
      id: 9,
      account_type: "personal",
      scope: "personal",
      effective_role: "owner",
      permissions: ["apps:use"],
    };
    renderSettings();

    const row = (await screen.findByText("Task statuses")).closest(
      ".settings-usage-row"
    );
    const open = row?.querySelector("button");
    open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(navigate).toHaveBeenCalledWith("/settings/statuses");
  });
});
