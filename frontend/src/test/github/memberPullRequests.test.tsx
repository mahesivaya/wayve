// Code Repo › Pull Requests for a non-owner. Anyone who can open the repo can
// read its pull requests and comment on them; the approve and merge cards are
// owner-only (the server enforces that too), so a member doesn't see them.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let mockRole = "member";
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 2, email: "m@test.local", effective_role: mockRole },
  }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

import { GitHubRepoViewer } from "../../github/GitHubRepo";

const OPEN_PR = {
  number: 124,
  title: "Open PR for members",
  html_url: "https://github.com/o/r/pull/124",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  locked: false,
  body: null,
  user: { login: "dev" },
  head: { ref: "feat", sha: "abc1234" },
  base: { ref: "main" },
  created_at: "2026-10-01T00:00:00Z",
};

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
        open_issues_count: 1,
        updated_at: "2026-10-01T00:00:00Z",
        visibility: "private",
      })
    );
  }
  if (url.includes("/pulls?state=open"))
    return Promise.resolve(json([OPEN_PR]));
  if (url.endsWith("/pulls/124")) return Promise.resolve(json(OPEN_PR));
  if (url.includes("/actions/runs")) {
    return Promise.resolve(json({ workflow_runs: [], total_count: 0 }));
  }
  return Promise.resolve(json([]));
});

const renderViewer = () =>
  render(
    <MemoryRouter>
      <GitHubRepoViewer owner="o" repo="r" />
    </MemoryRouter>
  );

describe("pull requests for a non-owner", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("rwayve.github.section", "pulls");
    localStorage.setItem("rwayve.github.pullFilter", "open");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    mockRole = "member";
  });

  it("lets a member read and comment, without approve or merge", async () => {
    renderViewer();
    fireEvent.click(await screen.findByText("Open PR for members"));
    expect(
      await screen.findByRole("textbox", {
        name: "Comment on this pull request",
      })
    ).toBeTruthy();
    expect(screen.queryByText("Owner review")).toBeNull();
    expect(screen.queryByText("Merge pull request")).toBeNull();
  });

  it("still shows an owner the approve card", async () => {
    mockRole = "owner";
    renderViewer();
    fireEvent.click(await screen.findByText("Open PR for members"));
    expect(await screen.findByText("Owner review")).toBeTruthy();
  });
});
