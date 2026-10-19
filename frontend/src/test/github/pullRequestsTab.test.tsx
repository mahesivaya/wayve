// Code Repo › Pull Requests. Each tab must ask GitHub for its own state.
//
// The list used to fetch the newest 50 PRs with `state=all` and filter in the
// browser, so an open PR older than the newest 50 never reached the Open tab:
// it read "No open pull requests" while GitHub had one open.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "o@test.local", effective_role: "owner" },
  }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

import { GitHubRepoViewer } from "../../github/GitHubRepo";

const pr = (number: number, state: "open" | "closed", title: string) => ({
  number,
  title,
  html_url: `https://github.com/o/r/pull/${number}`,
  state,
  draft: false,
  merged_at: state === "closed" ? "2026-10-01T00:00:00Z" : null,
  user: { login: "dev" },
  head: { ref: `branch-${number}` },
  base: { ref: "main" },
  created_at: "2026-07-31T00:00:00Z",
});

const OLD_OPEN = pr(124, "open", "Old but still open");
const MERGED = pr(176, "closed", "Recently merged");

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
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
        open_issues_count: 1,
        updated_at: "2026-10-01T00:00:00Z",
        visibility: "private",
      })
    );
  }
  if (url.includes("/pulls?state=open"))
    return Promise.resolve(json([OLD_OPEN]));
  if (url.includes("/pulls?state=closed&per_page=1")) {
    // 175 closed PRs: the true count comes from the Link header's last page.
    return Promise.resolve(
      json([MERGED], {
        Link: '<https://api.github.com/x?state=closed&per_page=1&page=2>; rel="next", <https://api.github.com/x?state=closed&per_page=1&page=175>; rel="last"',
      })
    );
  }
  if (url.includes("/pulls?state=closed"))
    return Promise.resolve(json([MERGED]));
  if (url.includes("/actions/runs")) {
    return Promise.resolve(json({ workflow_runs: [], total_count: 0 }));
  }
  if (url.includes("/actions/workflows")) {
    return Promise.resolve(json({ workflows: [], total_count: 0 }));
  }
  if (url.includes("/readme")) return Promise.resolve(json({ content: "" }));
  return Promise.resolve(json([]));
});

const pullUrls = () =>
  fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/pulls?"));

const renderViewer = () =>
  render(
    <MemoryRouter>
      <GitHubRepoViewer owner="o" repo="r" />
    </MemoryRouter>
  );

describe("Code Repo pull requests", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("rwayve.github.section", "pulls");
    localStorage.setItem("rwayve.github.pullFilter", "open");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows an open PR however old, by asking GitHub for open PRs", async () => {
    renderViewer();
    expect(await screen.findByText("Old but still open")).toBeTruthy();
    expect(screen.queryByText("Recently merged")).toBeNull();
    expect(pullUrls().some((u) => u.includes("state=all"))).toBe(false);
    expect(
      pullUrls().some((u) => u.includes("state=open&per_page=50&page=1"))
    ).toBe(true);
  });

  it("loads closed PRs when switching to the Closed tab", async () => {
    renderViewer();
    await screen.findByText("Old but still open");
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(await screen.findByText("Recently merged")).toBeTruthy();
    expect(screen.queryByText("Old but still open")).toBeNull();
    expect(
      pullUrls().some((u) => u.includes("state=closed&per_page=50&page=1"))
    ).toBe(true);
    // The panel count is the true closed total, not the rows on this page.
    expect(await screen.findByText("175")).toBeTruthy();
  });
});
