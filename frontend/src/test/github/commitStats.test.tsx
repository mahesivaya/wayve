// Code Repo › Commits: each commit's +/- line counts show with the list,
// without opening the commit first.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 2, scope: "organization", effective_role: "member" },
  }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

import { GitHubRepoViewer } from "../../github/GitHubRepo";

const commit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/o/r/commit/${sha}`,
  author: { login: "dev" },
  commit: {
    message,
    author: { name: "dev", date: "2026-11-16T00:00:00Z" },
  },
});

const STATS: Record<string, [number, number]> = {
  aaa1111: [12, 3],
  bbb2222: [5, 40],
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
        open_issues_count: 0,
        updated_at: "2026-10-01T00:00:00Z",
        visibility: "public",
      })
    );
  }
  if (url.includes("/commits?")) {
    return Promise.resolve(
      json([commit("aaa1111", "First change"), commit("bbb2222", "Second")])
    );
  }
  const detail = /\/commits\/(\w+)$/.exec(url);
  if (detail) {
    const [additions, deletions] = STATS[detail[1]];
    return Promise.resolve(
      json({
        sha: detail[1],
        files: [],
        stats: { total: additions + deletions, additions, deletions },
      })
    );
  }
  if (url.includes("/actions/runs")) {
    return Promise.resolve(json({ workflow_runs: [], total_count: 0 }));
  }
  return Promise.resolve(json([]));
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("rwayve.github.section", "commits");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("shows each commit's line counts without opening it", async () => {
  render(
    <MemoryRouter>
      <GitHubRepoViewer owner="o" repo="r" />
    </MemoryRouter>
  );
  expect(await screen.findByText("+12")).toBeTruthy();
  expect(screen.getByText("−3")).toBeTruthy();
  expect(await screen.findByText("+5")).toBeTruthy();
  expect(screen.getByText("−40")).toBeTruthy();
  // Nothing was opened to get them.
  expect(
    screen
      .getAllByRole("button", { name: /Toggle changes/ })
      .every((b) => b.getAttribute("aria-expanded") === "false")
  ).toBe(true);
});

// With IntersectionObserver available, only rows on screen are fetched; a row
// scrolled into view later is fetched then.
it("fetches line counts only for the commits on screen", async () => {
  type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
  let notify: Callback = () => {};
  const observed: Element[] = [];
  class StubIntersectionObserver {
    constructor(callback: Callback) {
      notify = callback;
    }
    observe(node: Element) {
      observed.push(node);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  const detailCalls = () =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => /\/commits\/\w+$/.test(url));

  render(
    <MemoryRouter>
      <GitHubRepoViewer owner="o" repo="r" />
    </MemoryRouter>
  );
  await screen.findByText("First change");
  await waitFor(() => expect(observed.length).toBe(2));
  // Both rows are watched, but nothing is fetched until one is on screen.
  expect(detailCalls()).toHaveLength(0);

  const row = (sha: string) =>
    observed.find((n) => (n as HTMLElement).dataset.commitSha === sha);
  act(() => notify([{ isIntersecting: true, target: row("aaa1111") }]));
  expect(await screen.findByText("+12")).toBeTruthy();
  expect(screen.queryByText("+5")).toBeNull();
  expect(detailCalls()).toHaveLength(1);

  act(() => notify([{ isIntersecting: true, target: row("bbb2222") }]));
  expect(await screen.findByText("+5")).toBeTruthy();
  expect(detailCalls()).toHaveLength(2);
});
