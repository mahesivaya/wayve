// The project page's members: owners and admins (members:manage) get the
// access panel to add and remove members; everyone else a read-only list.
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const session = vi.hoisted(() => ({ canManage: false }));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, scope: "organization" } }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: (_user: unknown, permission: string) =>
    permission === "members:manage" && session.canManage,
}));
const getRepoAccess = vi.hoisted(() => vi.fn());
vi.mock("../../api/repoAccess", () => ({
  getRepoAccess,
  getRepoSummary: () => Promise.resolve({ summary: "", can_edit: false }),
  setRepoSummary: vi.fn(),
}));
vi.mock("../../api/github", () => ({
  getVisibleProjects: () =>
    Promise.resolve({
      unrestricted: true,
      repos: [
        {
          full_name: "acme/web",
          name: "web",
          owner: { login: "acme" },
          html_url: "https://github.com/acme/web",
          description: null,
          private: true,
          default_branch: "main",
          language: null,
          updated_at: "",
        },
      ],
    }),
}));
vi.mock("../../github/RepoAccessPanel", () => ({
  default: ({ owner, repo }: { owner: string; repo: string }) => (
    <div data-testid="access-panel">
      {owner}/{repo}
    </div>
  ),
}));

import ProjectDetail from "../../projects/ProjectDetail";

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/projects/acme/web"]}>
      <Routes>
        <Route path="/projects/:owner/:repo" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  getRepoAccess.mockReset();
  getRepoAccess.mockResolvedValue({
    repo: "acme/web",
    github_readable: true,
    can_manage: false,
    rows: [
      {
        user_id: 2,
        github_login: null,
        email: "creator@test.local",
        level: "admin",
        in_dashboard: true,
        is_member: true,
        source: "wayve",
      },
    ],
  });
});

it("shows a member the read-only list", async () => {
  session.canManage = false;
  renderPage();
  expect(await screen.findByText("creator@test.local")).toBeTruthy();
  expect(screen.queryByTestId("access-panel")).toBeNull();
});

it("gives an owner or admin the access panel to add members", async () => {
  session.canManage = true;
  renderPage();
  expect((await screen.findByTestId("access-panel")).textContent).toBe(
    "acme/web"
  );
  // The panel loads the members itself; the page does not fetch them twice.
  expect(getRepoAccess).not.toHaveBeenCalled();
});
