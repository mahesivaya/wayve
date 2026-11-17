// Settings › Administration: admins get Teams and Projects pages listing
// everything in their scope; anyone else is told the page is not for them.
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const session = vi.hoisted(() => ({ role: "owner", scope: "organization" }));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, scope: session.scope, effective_role: session.role },
  }),
}));
const listTeams = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn());
vi.mock("../../api/workspace", () => ({ listTeams, listProjects }));

import { AdminProjects, AdminTeams } from "../../settings/Administration";
import { isWorkspaceAdmin } from "../../auth/workspaceAdmin";

beforeEach(() => {
  session.role = "owner";
  session.scope = "organization";
  listTeams.mockReset();
  listProjects.mockReset();
  listTeams.mockResolvedValue([
    { id: 1, name: "Design", slug: "design", tagline: null, description: null },
  ]);
  listProjects.mockResolvedValue([
    { id: 1, name: "Website", github_owner: "acme", github_repo: "web" },
    { id: 2, name: "Roadmap", github_owner: null, github_repo: null },
  ]);
});

it("lists every team with a link to its page", async () => {
  render(
    <MemoryRouter>
      <AdminTeams />
    </MemoryRouter>
  );
  const open = await screen.findByRole("link", { name: "Open Design" });
  expect(open.getAttribute("href")).toBe("/teams/design");
});

it("lists every project, linking the ones with a repository", async () => {
  render(
    <MemoryRouter>
      <AdminProjects />
    </MemoryRouter>
  );
  const open = await screen.findByRole("link", { name: "Open Website" });
  expect(open.getAttribute("href")).toBe("/projects/acme/web");
  expect(screen.getByText("Roadmap")).toBeTruthy();
  expect(screen.getByText("No repository linked")).toBeTruthy();
});

it("loads nothing for someone who is not an admin", () => {
  session.role = "member";
  render(
    <MemoryRouter>
      <AdminTeams />
    </MemoryRouter>
  );
  expect(screen.getByText(/Only owners and admins/)).toBeTruthy();
  expect(listTeams).not.toHaveBeenCalled();
});

it("counts owners, super admins and admins of an org or the platform", () => {
  const user = (scope: string, effective_role: string) => ({
    scope,
    effective_role,
  });
  expect(isWorkspaceAdmin(user("organization", "owner"))).toBe(true);
  expect(isWorkspaceAdmin(user("platform", "super_admin"))).toBe(true);
  expect(isWorkspaceAdmin(user("organization", "admin"))).toBe(true);
  expect(isWorkspaceAdmin(user("organization", "member"))).toBe(false);
  expect(isWorkspaceAdmin(user("personal", "owner"))).toBe(false);
  expect(isWorkspaceAdmin(null)).toBe(false);
});
