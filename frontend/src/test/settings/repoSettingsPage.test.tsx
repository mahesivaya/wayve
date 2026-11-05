// Each repository's Settings button opens a page for choosing who may access it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mockAuth: { user: Record<string, unknown> | null; logout: () => void } = {
  user: null,
  logout: vi.fn(),
};
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockAuth }));

const listProjects = vi.fn();
vi.mock("../../api/workspace", () => ({
  listProjects: () => listProjects(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));

const listImportableRepos = vi.fn();
const getVisibleProjects = vi.fn();
vi.mock("../../api/github", () => ({
  listImportableRepos: () => listImportableRepos(),
  getGithubConnection: () => Promise.resolve({ connected: true, login: "me" }),
  getGithubConnectUrl: vi.fn(),
  disconnectGithub: vi.fn(),
  getVisibleProjects: () => getVisibleProjects(),
}));

const getRepoAccess = vi.fn();
const setRepoAccess = vi.fn();
const removeRepoAccess = vi.fn();
vi.mock("../../api/repoAccess", () => ({
  getRepoAccess: (o: string, r: string) => getRepoAccess(o, r),
  setRepoAccess: (o: string, r: string, p: unknown) => setRepoAccess(o, r, p),
  removeRepoAccess: (o: string, r: string, t: unknown) =>
    removeRepoAccess(o, r, t),
}));

const listOrganizationMembers = vi.fn();
const listPlatformMembers = vi.fn();
vi.mock("../../api/rbac", () => ({
  listOrganizationMembers: (id: number) => listOrganizationMembers(id),
  listPlatformMembers: () => listPlatformMembers(),
}));

import RepoSettingsPage from "../../settings/RepoSettingsPage";
import RepositorySettings from "../../settings/RepositorySettings";

const orgOwner = {
  id: 1,
  account_type: "organization_admin",
  scope: "organization",
  effective_role: "owner",
  organization_id: 5,
};
const member = (user_id: number, email: string, role = "member") => ({
  user_id,
  email,
  username: null,
  role,
  role_label: role,
});
const access = (rows: unknown[] = []) => ({
  repo: "acme/api",
  github_readable: true,
  can_manage: true,
  rows,
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/repositories" element={<RepositorySettings />} />
        <Route
          path="/settings/repositories/:owner/:repo"
          element={<RepoSettingsPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = orgOwner;
  listProjects.mockResolvedValue([
    { id: 7, name: "api", github_owner: "acme", github_repo: "api" },
  ]);
  listImportableRepos.mockResolvedValue({ connected: true, repos: [] });
  getRepoAccess.mockResolvedValue(access());
  listOrganizationMembers.mockResolvedValue([]);
  listPlatformMembers.mockResolvedValue([]);
  setRepoAccess.mockResolvedValue({
    dashboard_updated: true,
    github_outcome: "skipped",
  });
});
afterEach(cleanup);

describe("the Settings button", () => {
  it("opens the repository's own page", async () => {
    renderAt("/settings/repositories");
    await userEvent.click(
      await screen.findByRole("link", { name: "Settings for acme/api" })
    );
    expect(
      await screen.findByRole("heading", { name: "acme/api" })
    ).toBeTruthy();
    expect(getRepoAccess).toHaveBeenCalledWith("acme", "api");
  });

  it("isn't offered to someone who can't manage access", async () => {
    mockAuth.user = { ...orgOwner, effective_role: "member" };
    renderAt("/settings/repositories");
    await screen.findByText("acme/api");
    expect(screen.queryByRole("link", { name: /^Settings for/ })).toBeNull();
  });

  it("appears on platform repositories too", async () => {
    mockAuth.user = {
      id: 2,
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "owner",
    };
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [{ full_name: "acme/api", name: "api", private: false }],
    });
    renderAt("/settings/repositories");
    const link = await screen.findByRole("link", {
      name: "Settings for acme/api",
    });
    expect(link.getAttribute("href")).toBe("/settings/repositories/acme/api");
  });
});

describe("granting access", () => {
  it("grants a chosen member at the chosen level", async () => {
    listOrganizationMembers.mockResolvedValue([member(11, "sam@acme.test")]);
    renderAt("/settings/repositories/acme/api");

    const select = await screen.findByLabelText("Member");
    await userEvent.selectOptions(select, "11");
    await userEvent.selectOptions(
      screen.getByLabelText("Access level"),
      "write"
    );
    await userEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(listOrganizationMembers).toHaveBeenCalledWith(5);
    expect(setRepoAccess).toHaveBeenCalledWith("acme", "api", {
      user_id: 11,
      level: "write",
    });
  });

  it("leaves out those a grant wouldn't change anything for", async () => {
    listOrganizationMembers.mockResolvedValue([
      member(11, "sam@acme.test"),
      member(12, "granted@acme.test"),
      member(13, "boss@acme.test", "admin"),
      member(14, "visitor@acme.test", "guest"),
    ]);
    getRepoAccess.mockResolvedValue(
      access([
        {
          user_id: 12,
          github_login: null,
          email: "granted@acme.test",
          level: "read",
          in_dashboard: true,
          is_member: true,
          source: "wayve",
        },
      ])
    );
    renderAt("/settings/repositories/acme/api");

    const select = await screen.findByLabelText("Member");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a member…",
      "sam@acme.test",
    ]);
  });

  it("still takes a GitHub username if the members can't be listed", async () => {
    listOrganizationMembers.mockRejectedValue(new Error("nope"));
    renderAt("/settings/repositories/acme/api");

    await userEvent.type(
      await screen.findByLabelText("GitHub username"),
      "octocat"
    );
    await userEvent.click(screen.getByRole("button", { name: "Add access" }));

    expect(screen.queryByLabelText("Member")).toBeNull();
    expect(setRepoAccess).toHaveBeenCalledWith("acme", "api", {
      github_login: "octocat",
      level: "read",
    });
  });

  it("tells a personal account that this is GitHub-only", async () => {
    mockAuth.user = {
      id: 3,
      account_type: "personal",
      scope: "personal",
      effective_role: "owner",
    };
    renderAt("/settings/repositories/acme/api");
    expect(await screen.findByText(/aren.t shared inside Wayve/)).toBeTruthy();
    expect(listOrganizationMembers).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Member")).toBeNull();
  });

  it("explains itself to someone who can't manage access", async () => {
    mockAuth.user = { ...orgOwner, effective_role: "member" };
    renderAt("/settings/repositories/acme/api");
    expect(screen.getByText(/can change who has access/)).toBeTruthy();
    expect(getRepoAccess).not.toHaveBeenCalled();
  });
});
