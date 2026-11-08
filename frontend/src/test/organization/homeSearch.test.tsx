// The org home is where an organization member lands after login: just the AI
// ask-box, the same embedded surface the platform home uses. The console tiles
// moved to the Analytics page (/organization/analytics), where the header
// search box filters them. The header search box is suppressed on the home
// routes (see HIDE_SEARCH_PATHS), so it must not render on the home.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@fluxze.com",
      scope: "organization",
      account_type: "organization_admin",
      organization_id: 7,
      effective_role: "owner",
      permissions: [
        "members:read",
        "members:manage",
        "billing:read",
        "api_keys:manage",
      ],
    },
  }),
}));

// The AI surface talks to the model backend on mount; stub it. Its own
// behaviour is covered by the aichat tests — here we only care that the home
// leads with it.
vi.mock("../../aichat/AIChat", () => ({
  default: () => <div data-testid="ai-chat">AI</div>,
}));

// The tiles fetch live counts on mount; none of that matters here.
vi.mock("../../api/rbac", () => ({
  listOrganizationMembers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/billing", () => ({
  getOrganizationBilling: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../api/apiKeys", () => ({
  listApiKeys: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/audit", () => ({
  listAuditLogs: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/sharedInboxes", () => ({
  listSharedInboxes: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/sso", () => ({
  getSsoConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../api/webhooks", () => ({
  listWebhooks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/scim", () => ({
  listScimTokens: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../api/github", () => ({
  listGithubRepos: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../orgKeys/api", () => ({
  getOrgKeys: vi.fn().mockResolvedValue(null),
}));

import SearchProvider from "../../search/SearchProvider";
import SearchBar from "../../search/SearchBar";
import OrganizationAdminHome from "../../organization/OrganizationAdminHome";
import OrganizationConsoleCards from "../../organization/OrganizationConsoleCards";

// Mirrors how Layout composes them: the header search box, then the page.
const renderAt = (path: string, page: ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SearchProvider>
        <SearchBar />
        {page}
      </SearchProvider>
    </MemoryRouter>
  );

describe("organization home", () => {
  it("shows the AI surface and no console tiles", () => {
    const { container } = renderAt(
      "/organization/home",
      <OrganizationAdminHome />
    );
    expect(screen.getByTestId("ai-chat")).toBeInTheDocument();
    expect(container.querySelector(".org-home-tile")).toBeNull();
  });

  it("does not render the header search box on this route", () => {
    renderAt("/organization/home", <OrganizationAdminHome />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("organization console tiles on Analytics", () => {
  const renderCards = () =>
    renderAt("/organization/analytics", <OrganizationConsoleCards />);

  it("shows only the tiles the user has permission for", () => {
    renderCards();
    for (const label of ["Members & roles", "Billing", "Developer"]) {
      expect(
        screen.getByRole("button", { name: `Open ${label}` })
      ).toBeInTheDocument();
    }
    // No webhooks:manage / sso:manage / ai:manage in the mocked permissions.
    for (const label of ["Webhooks", "SSO", "AI Provider"]) {
      expect(
        screen.queryByRole("button", { name: `Open ${label}` })
      ).not.toBeInTheDocument();
    }
  });

  it("filters the tiles with the header search box", () => {
    renderCards();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "invoice" },
    });
    expect(
      screen.getByRole("button", { name: "Open Billing" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Members & roles" })
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(/Nothing here matches/)).toBeInTheDocument();
  });
});
