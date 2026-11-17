// Code Repo › the per-repo Access tab is for admins only: an organization or
// platform owner, super admin or admin. A personal account is "owner" of its
// own workspace but must not see it, nor may lower roles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let mockUser: Record<string, unknown> = {};
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

import { GitHubRepoViewer } from "../../github/GitHubRepo";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/api/github/repos/o/r")) {
    return Promise.resolve(
      json({
        full_name: "o/r",
        description: null,
        default_branch: "main",
        html_url: "https://github.com/o/r",
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        updated_at: "2026-10-01T00:00:00Z",
        visibility: "private",
      })
    );
  }
  if (url.includes("/actions/runs")) {
    return Promise.resolve(json({ workflow_runs: [], total_count: 0 }));
  }
  return Promise.resolve(json([]));
});

async function accessTabShown(user: Record<string, unknown>) {
  mockUser = { id: 2, email: "u@test.local", ...user };
  render(
    <MemoryRouter>
      <GitHubRepoViewer owner="o" repo="r" />
    </MemoryRouter>
  );
  // The section list is up once Commits shows.
  await screen.findByText("Commits");
  return screen.queryByText("Access") !== null;
}

describe("repo Access tab", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows for an organization owner", async () => {
    expect(
      await accessTabShown({ scope: "organization", effective_role: "owner" })
    ).toBe(true);
  });

  it("shows for an admin holding members:manage", async () => {
    expect(
      await accessTabShown({
        scope: "organization",
        effective_role: "admin",
        permissions: ["members:manage"],
      })
    ).toBe(true);
  });

  it("is hidden from a developer", async () => {
    expect(
      await accessTabShown({
        scope: "organization",
        effective_role: "developer",
        permissions: ["apps:use"],
      })
    ).toBe(false);
  });

  it("is hidden from a personal account, though it owns its workspace", async () => {
    expect(
      await accessTabShown({
        scope: "personal",
        account_type: "personal",
        effective_role: "owner",
        permissions: ["members:manage"],
      })
    ).toBe(false);
  });
});
