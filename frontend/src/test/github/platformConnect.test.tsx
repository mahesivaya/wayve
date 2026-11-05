// Code Repo on the platform side. A platform owner (admin mode) can connect
// their own GitHub; the repo switcher then lists the server's merged list
// (shared token + their own, private repos included). Other platform roles
// keep the shared token's list and get no connect control.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let mockUser: Record<string, unknown> = {};
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

const listImportableRepos = vi.fn();
const getGithubConnection = vi.fn();
vi.mock("../../api/github", () => ({
  listImportableRepos: () => listImportableRepos(),
  getGithubConnection: () => getGithubConnection(),
  getGithubConnectUrl: vi.fn(),
  disconnectGithub: vi.fn(),
  approvePullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  createCommitComment: vi.fn(),
}));

import GitHubRepo from "../../github/GitHubRepo";

const repo = (fullName: string, isPrivate: boolean) => {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    description: null,
    private: isPrivate,
    default_branch: "main",
    language: null,
    updated_at: "2026-10-01T00:00:00Z",
  };
};

// The viewer behind the switcher fetches through the proxy; any JSON will do,
// except /user/repos, which is the shared-token list non-owners still use.
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes("/user/repos")
    ? [repo("acme/shared", false)]
    : url.includes("/actions/runs")
      ? { workflow_runs: [], total_count: 0 }
      : [];
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/github"]}>
      <Routes>
        <Route path="/github" element={<GitHubRepo />} />
      </Routes>
    </MemoryRouter>
  );

// The list only exists once opened, and only holds the repos once they've loaded.
const openRepoList = async (repoName: string) => {
  await userEvent.click(
    await screen.findByRole("button", { name: /^Select a repository/ })
  );
  await screen.findByRole("option", { name: repoName });
};

describe("platform Code Repo GitHub connect", () => {
  beforeEach(() => {
    listImportableRepos.mockReset();
    getGithubConnection.mockReset();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("offers a platform owner Connect GitHub", async () => {
    mockUser = { id: 1, scope: "platform", effective_role: "owner" };
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("acme/shared", false)],
    });
    getGithubConnection.mockResolvedValue({ connected: false });
    renderPage();
    const btn = await screen.findByRole("button", {
      name: "Connect GitHub to import your repos",
    });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("lists a connected owner's private repos alongside the shared ones", async () => {
    mockUser = { id: 1, scope: "platform", effective_role: "owner" };
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("acme/shared", false), repo("owner-login/secret", true)],
    });
    getGithubConnection.mockResolvedValue({
      connected: true,
      login: "owner-login",
    });
    renderPage();
    await openRepoList("secret");
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByText(/@owner-login/)).toBeNull();
    expect(screen.getByRole("option", { name: "shared" })).toBeTruthy();
  });

  it("keeps other platform roles on the shared list, with no connect", async () => {
    mockUser = { id: 2, scope: "platform", effective_role: "member" };
    renderPage();
    await openRepoList("shared");
    expect(
      screen.queryByRole("button", {
        name: "Connect GitHub to import your repos",
      })
    ).toBeNull();
    expect(listImportableRepos).not.toHaveBeenCalled();
    expect(getGithubConnection).not.toHaveBeenCalled();
  });
});
