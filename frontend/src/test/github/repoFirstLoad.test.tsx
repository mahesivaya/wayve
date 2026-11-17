// First load of the Code Repo page: the files don't wait for the branch list
// (which pages slowly on a repo with hundreds of branches), and the Actions run
// list, the page's largest response, loads only when Actions is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, scope: "platform", effective_role: "member" },
  }),
}));

import GitHubRepo from "../../github/GitHubRepo";
import {
  rememberOpenRepo,
  rememberRepoView,
  type RepoView,
} from "../../github/openRepoSession";

const API = "/api/github/repos/acme/app";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// The branch list answers only when a test releases it.
let releaseBranches: (names: string[]) => void;
let branchesReply: Promise<Response>;

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const full = String(input);
  const url = full.split("?")[0];
  if (url.endsWith(`${API}/branches`)) return branchesReply;
  let body: unknown = [];
  if (url.endsWith(API))
    body = { default_branch: "main", full_name: "acme/app" };
  else if (url.endsWith(`${API}/contents`))
    body = [
      {
        name: "README.md",
        path: "README.md",
        type: "file",
        size: 10,
        download_url: null,
      },
    ];
  else if (url.includes("/actions/runs"))
    body = { workflow_runs: [], total_count: 42 };
  return Promise.resolve(json(body));
});

const urls = () => fetchMock.mock.calls.map(([input]) => String(input));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/github"]}>
      <Routes>
        <Route path="/github" element={<GitHubRepo />} />
      </Routes>
    </MemoryRouter>
  );

const view = (fields: Partial<RepoView>): RepoView => ({
  branch: null,
  pull: null,
  file: null,
  folders: [],
  commits: [],
  commitsPage: 1,
  pullsPage: 1,
  collapsedFiles: [],
  openPullFiles: [],
  commitDrafts: {},
  pullDrafts: {},
  ...fields,
});

describe("Code Repo first load", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    fetchMock.mockClear();
    branchesReply = new Promise<Response>((resolve) => {
      releaseBranches = (names) =>
        resolve(json(names.map((name) => ({ name }))));
    });
    vi.stubGlobal("fetch", fetchMock);
    rememberOpenRepo(1, "acme/app");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the files while the branch list is still loading", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Files/ }));
    expect(await screen.findByRole("button", { name: /README/ })).toBeTruthy();
    // Loaded for the default branch, with the branch list still unanswered.
    expect(urls().some((u) => u.includes("/contents?ref=main"))).toBe(true);

    releaseBranches(["main", "dev"]);
    await waitFor(() =>
      expect(urls().filter((u) => u.includes("/contents?ref=")).length).toBe(1)
    );
  });

  it("loads the Actions runs only once Actions is opened, but still counts them", async () => {
    localStorage.setItem("rwayve.github.section", "description");
    renderPage();
    const actions = await screen.findByRole("button", { name: /Actions/ });
    // The sidebar count comes from a one-row request.
    await waitFor(() => expect(actions.textContent).toContain("42"));
    expect(urls().some((u) => u.includes("/actions/runs?per_page=1"))).toBe(
      true
    );
    expect(urls().some((u) => u.includes("/actions/runs?per_page=50"))).toBe(
      false
    );

    await userEvent.click(actions);
    await waitFor(() =>
      expect(urls().some((u) => u.includes("/actions/runs?per_page=50"))).toBe(
        true
      )
    );
  });

  it("moves to the default branch when the remembered one was deleted", async () => {
    rememberRepoView(1, "acme/app", view({ branch: "gone" }));
    renderPage();
    // Starts on the remembered branch without waiting for the list…
    await waitFor(() =>
      expect(urls().some((u) => u.includes("/contents?ref=gone"))).toBe(true)
    );
    // …and falls back once the list shows it no longer exists.
    releaseBranches(["main"]);
    await waitFor(() =>
      expect(urls().some((u) => u.includes("/contents?ref=main"))).toBe(true)
    );
  });

  it("stays on a remembered branch that still exists", async () => {
    rememberRepoView(1, "acme/app", view({ branch: "dev" }));
    renderPage();
    await waitFor(() =>
      expect(urls().some((u) => u.includes("/contents?ref=dev"))).toBe(true)
    );
    releaseBranches(["main", "dev"]);
    await screen.findByRole("button", { name: /Actions/ });
    expect(urls().some((u) => u.includes("/contents?ref=main"))).toBe(false);
  });
});
