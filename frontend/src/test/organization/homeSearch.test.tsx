// The org home is where an organization member lands after login. It leads
// with the AI ask-box (same embedded surface the platform home uses), with the
// console/app tiles below it. The header search box narrows those tiles — it
// used to render on this page and do nothing at all when you typed in it.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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

// Mirrors how Layout composes them: the header search box, then the page.
const renderHome = () =>
  render(
    <MemoryRouter initialEntries={["/organization/home"]}>
      <SearchProvider>
        <SearchBar />
        <OrganizationAdminHome />
      </SearchProvider>
    </MemoryRouter>
  );

describe("organization home", () => {
  it("leads with the AI surface, above the tiles", () => {
    const { container } = renderHome();
    const ai = screen.getByTestId("ai-chat");
    const firstTile = container.querySelector(".org-home-tile");
    expect(firstTile).toBeTruthy();
    // FOLLOWING = the tile comes after the AI box in document order.
    expect(
      ai.compareDocumentPosition(firstTile!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the header search box on this route", () => {
    renderHome();
    expect(
      screen.getByRole("searchbox", { name: /search apps and settings/i })
    ).toBeInTheDocument();
  });

  it("filters the console tiles as you type", () => {
    renderHome();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Billing")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "project" },
    });

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
  });

  it("matches on the tile description, not just the title", () => {
    renderHome();
    // "invoices" only appears in Billing's blurb.
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "invoices" },
    });

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });

  it("explains an empty result instead of rendering a blank page", () => {
    renderHome();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzzznope" },
    });

    expect(screen.getByText(/nothing here matches/i)).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });
});
