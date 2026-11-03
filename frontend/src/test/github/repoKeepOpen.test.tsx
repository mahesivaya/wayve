// Code Repo comes back as it was left: every route change unmounts the page, so
// the repo, branch, pull request, file, folders and commits return from
// sessionStorage when the real page mounts again.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let mockUser: Record<string, unknown> = {};
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

const listProjects = vi.hoisted(() => vi.fn());
vi.mock("../../api/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listProjects: () => listProjects(),
}));

import GitHubRepo from "../../github/GitHubRepo";
import {
  draftStore,
  forgetOpenRepo,
  readOpenRepo,
  readRepoView,
  rememberOpenRepo,
  rememberRepoView,
  type RepoView,
} from "../../github/openRepoSession";

const USER = 1;
const FULL = "acme/app";
const API = `/api/github/repos/${FULL}`;
const SHA = "abc1234";

const view = (fields: Partial<RepoView> = {}): RepoView => ({
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

const pull = {
  number: 7,
  title: "Add the thing",
  body: "",
  state: "open",
  draft: false,
  merged: false,
  user: { login: "dev" },
  head: { ref: "feat", sha: SHA },
  base: { ref: "main", sha: "def5678" },
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  html_url: "https://github.com/acme/app/pull/7",
};

// Answers by URL; anything else is an empty list.
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input).split("?")[0];
  let body: unknown = [];
  if (url.endsWith(API)) body = { default_branch: "main", full_name: FULL };
  else if (url.endsWith(`${API}/branches`))
    body = [{ name: "main" }, { name: "dev" }];
  else if (url.endsWith(`${API}/pulls`)) body = [pull];
  else if (url.endsWith(`${API}/pulls/7`)) body = pull;
  else if (url.endsWith(`${API}/pulls/7/files`))
    body = ["opened.ts", "closed.ts"].map((filename) => ({
      filename,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -1,1 +1,2 @@\n keep\n+added",
    }));
  else if (url.endsWith(`${API}/contents/src/app.ts`))
    body = {
      name: "app.ts",
      path: "src/app.ts",
      type: "file",
      size: 4,
      download_url: "https://raw.test/app.ts?token=secret",
    };
  else if (url === "https://raw.test/app.ts") body = "code";
  else if (url.endsWith(`${API}/commits/${SHA}`))
    body = { sha: SHA, files: [] };
  else if (url.includes("/actions/runs"))
    body = { workflow_runs: [], total_count: 0 };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

const urls = () => fetchMock.mock.calls.map(([input]) => String(input));
const fetched = (part: string) => urls().some((url) => url.includes(part));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/github"]}>
      <Routes>
        <Route path="/github" element={<GitHubRepo />} />
      </Routes>
    </MemoryRouter>
  );

// The platform page takes its repo from the session, which needs no projects.
const leaveOff = (fields: Partial<RepoView>) => {
  rememberOpenRepo(USER, FULL);
  rememberRepoView(USER, FULL, view(fields));
};

describe("Code Repo keeps its place", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    mockUser = { id: USER, scope: "platform", effective_role: "member" };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("returns to the repo and branch it was left on, without loading the default first", async () => {
    leaveOff({ branch: "dev" });
    renderPage();
    await waitFor(() => expect(fetched(`${API}/contents?ref=dev`)).toBe(true));
    expect(fetched(`${API}/contents?ref=main`)).toBe(false);
  });

  it("falls back to the default when the branch has been deleted", async () => {
    leaveOff({ branch: "gone", file: "src/app.ts", folders: ["src"] });
    renderPage();
    await waitFor(() => expect(fetched(`${API}/contents?ref=main`)).toBe(true));
    // Its file and folders belonged to that branch.
    expect(fetched(`${API}/contents/src`)).toBe(false);
  });

  it("shows the pull request again after leaving the page and coming back", async () => {
    rememberOpenRepo(USER, FULL);
    localStorage.setItem("rwayve.github.section", "pulls");
    renderPage();
    fireEvent.click(await screen.findByText("Add the thing"));
    await screen.findByText("← Back to pull requests");
    await waitFor(() => expect(readRepoView(USER, FULL)?.pull).toBe(7));

    // Switching tabs unmounts the page.
    cleanup();
    fetchMock.mockClear();
    renderPage();
    await screen.findByText("← Back to pull requests");
    expect(fetched(`${API}/pulls/7`)).toBe(true);
    expect(readRepoView(USER, FULL)?.pull).toBe(7);

    // Going back to the list is remembered too.
    fireEvent.click(screen.getByText("← Back to pull requests"));
    await waitFor(() => expect(readRepoView(USER, FULL)?.pull).toBeNull());
  });

  it("returns to the page of commits and of pull requests it was left on", async () => {
    leaveOff({ branch: "main", commitsPage: 3, pullsPage: 2 });
    renderPage();
    await waitFor(() => expect(fetched(`sha=main`)).toBe(true));
    await waitFor(() => expect(fetched(`${API}/pulls?`)).toBe(true));
    const page = (part: string) =>
      urls()
        .filter((url) => url.includes(part))
        .map((url) => new URL(url, "http://x").searchParams.get("page"));
    expect(page(`${API}/commits?sha=main`)).toContain("3");
    expect(page(`${API}/pulls?state=`)).toContain("2");
  });

  it("starts a deleted branch's replacement on its first page of commits", async () => {
    leaveOff({ branch: "gone", commitsPage: 3 });
    renderPage();
    await waitFor(() => expect(fetched(`sha=main`)).toBe(true));
    expect(
      urls().some((url) => url.includes("sha=main") && url.includes("page=3"))
    ).toBe(false);
  });

  it("brings back the pull request's opened files and half-written comment", async () => {
    localStorage.setItem("rwayve.github.section", "pulls");
    leaveOff({
      branch: "main",
      pull: 7,
      openPullFiles: ["pr-7::opened.ts"],
      pullDrafts: { "7": "half written" },
    });
    renderPage();
    const expanded = (name: string) =>
      screen.getByText(name).closest("button")?.getAttribute("aria-expanded");
    await screen.findByText("opened.ts");
    expect(expanded("opened.ts")).toBe("true");
    expect(expanded("closed.ts")).toBe("false");
    expect(screen.getByDisplayValue("half written")).toBeTruthy();
  });

  it("keeps a pull request file open when it holds a half-written comment", async () => {
    localStorage.setItem("rwayve.github.section", "pulls");
    leaveOff({ branch: "main", pull: 7 });
    draftStore(USER, `${FULL}|pull:7:${SHA}:closed.ts`).save({
      body: "on a line",
      anchor: { side: "RIGHT", line: 2, position: 2 },
    });
    renderPage();
    expect(await screen.findByDisplayValue("on a line")).toBeTruthy();
    expect(
      screen
        .getByText("opened.ts")
        .closest("button")
        ?.getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("brings back a commit's half-written comment and folded files", async () => {
    leaveOff({
      branch: "main",
      commits: [SHA],
      commitDrafts: { [SHA]: "half a commit comment" },
      collapsedFiles: [`${SHA}::a.ts`],
    });
    renderPage();
    await waitFor(() =>
      expect(readRepoView(USER, FULL)?.commitDrafts).toEqual({
        [SHA]: "half a commit comment",
      })
    );
    expect(readRepoView(USER, FULL)?.collapsedFiles).toEqual([`${SHA}::a.ts`]);
  });

  it("reopens folders and the file on their branch", async () => {
    leaveOff({ branch: "dev", file: "src/app.ts", folders: ["src"] });
    renderPage();
    await waitFor(() =>
      expect(fetched(`${API}/contents/src?ref=dev`)).toBe(true)
    );
    await waitFor(() =>
      expect(fetched(`${API}/contents/src/app.ts?ref=dev`)).toBe(true)
    );
    await waitFor(() => expect(fetched("https://raw.test/app.ts")).toBe(true));
    await waitFor(() =>
      expect(readRepoView(USER, FULL)).toMatchObject({
        file: "src/app.ts",
        folders: ["src"],
      })
    );
  });

  it("never stores the file's signed download link", async () => {
    leaveOff({ branch: "main", file: "src/app.ts" });
    renderPage();
    await waitFor(() => expect(fetched("https://raw.test/app.ts")).toBe(true));
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("token=secret");
  });

  it("reopens the commits that were expanded", async () => {
    leaveOff({ branch: "main", commits: [SHA] });
    renderPage();
    await waitFor(() => expect(fetched(`${API}/commits/${SHA}`)).toBe(true));
    expect(readRepoView(USER, FULL)?.commits).toEqual([SHA]);
  });

  it("ignores what another user left in this tab", async () => {
    rememberOpenRepo(2, "acme/private");
    rememberRepoView(2, "acme/private", view({ pull: 7 }));
    renderPage();
    await waitFor(() => expect(urls().length).toBeGreaterThan(0));
    expect(fetched("acme/private")).toBe(false);
  });

  it("a deep link wins over the remembered repo", async () => {
    rememberOpenRepo(USER, "acme/other");
    render(
      <MemoryRouter initialEntries={[`/github?owner=acme&repo=app`]}>
        <Routes>
          <Route path="/github" element={<GitHubRepo />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(fetched(API)).toBe(true));
    expect(fetched("acme/other")).toBe(false);
    expect(readOpenRepo(USER)).toBe(FULL);
  });

  it("returns a personal account to its project, or the first if it's gone", async () => {
    mockUser = { id: USER, account_type: "personal", scope: "personal" };
    const project = (id: number, repo: string) => ({
      id,
      name: repo,
      github_owner: "acme",
      github_repo: repo,
      github_url: `https://github.com/acme/${repo}`,
    });
    listProjects.mockResolvedValue([project(1, "first"), project(2, "second")]);

    rememberOpenRepo(USER, 2);
    renderPage();
    await screen.findByRole("combobox", { name: "Select a repository" });
    expect(
      (
        screen.getByRole("combobox", {
          name: "Select a repository",
        }) as HTMLSelectElement
      ).value
    ).toBe("2");
    cleanup();

    rememberOpenRepo(USER, 99);
    renderPage();
    await screen.findByRole("combobox", { name: "Select a repository" });
    expect(
      (
        screen.getByRole("combobox", {
          name: "Select a repository",
        }) as HTMLSelectElement
      ).value
    ).toBe("1");
  });
});

describe("the session entry", () => {
  beforeEach(() => sessionStorage.clear());

  it("belongs to one user and is gone after forgetting", () => {
    rememberOpenRepo(USER, FULL);
    rememberRepoView(USER, FULL, view({ pull: 3 }));
    expect(readOpenRepo(USER)).toBe(FULL);
    expect(readOpenRepo(2)).toBeNull();
    expect(readOpenRepo(undefined)).toBeNull();
    expect(readRepoView(2, FULL)).toBeNull();

    forgetOpenRepo();
    expect(readOpenRepo(USER)).toBeNull();
    expect(readRepoView(USER, FULL)).toBeNull();
  });

  it("keeps each repo's view, and the repo, when the other changes", () => {
    rememberOpenRepo(USER, 5);
    rememberRepoView(USER, "a/one", view({ pull: 1 }));
    rememberRepoView(USER, "a/two", view({ pull: 2 }));
    rememberOpenRepo(USER, 6);
    expect(readRepoView(USER, "a/one")?.pull).toBe(1);
    expect(readRepoView(USER, "a/two")?.pull).toBe(2);
    expect(readOpenRepo(USER)).toBe(6);
  });

  it("survives corrupt or wrong-shaped storage", () => {
    sessionStorage.setItem("rwayve.github.open", "{not json");
    expect(readOpenRepo(USER)).toBeNull();

    sessionStorage.setItem(
      "rwayve.github.open",
      JSON.stringify({
        userId: USER,
        repo: { nope: 1 },
        views: {
          [FULL]: { branch: 4, pull: "7", folders: "src", commits: [1] },
        },
      })
    );
    expect(readOpenRepo(USER)).toBeNull();
    expect(readRepoView(USER, FULL)).toEqual(view());
    expect(readRepoView(USER, "__proto__")).toBeNull();
  });

  it("caps what comes back, keeping the most recent", () => {
    const shas = Array.from({ length: 15 }, (_, i) => `sha${i}`);
    rememberRepoView(USER, FULL, view({ commits: shas }));
    const commits = readRepoView(USER, FULL)?.commits ?? [];
    expect(commits).toHaveLength(10);
    expect(commits[commits.length - 1]).toBe("sha14");
  });
});
