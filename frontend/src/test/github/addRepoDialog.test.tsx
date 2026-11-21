// Adding repositories in Code Repo: clone by URL or import from GitHub,
// without leaving for Settings. There is no "+ Add" in the menu; the form shows
// on the empty page (no repositories yet), and a personal account returning
// from connecting GitHub gets it as a dialog to pick what to import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let mockUser: Record<string, unknown> = {};
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));
vi.mock("../../auth/token", () => ({ getAuthToken: () => "t" }));
vi.mock("../../github/RepoAccessPanel", () => ({ default: () => null }));

const listProjects = vi.hoisted(() => vi.fn());
const createProject = vi.hoisted(() => vi.fn());
vi.mock("../../api/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listProjects: () => listProjects(),
  createProject: (name: string, url: string) => createProject(name, url),
}));

const listImportableRepos = vi.hoisted(() => vi.fn());
const getGithubConnection = vi.hoisted(() => vi.fn());
const disconnectGithub = vi.hoisted(() => vi.fn());
vi.mock("../../api/github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listImportableRepos: () => listImportableRepos(),
  getGithubConnection: () => getGithubConnection(),
  disconnectGithub: () => disconnectGithub(),
}));

import GitHubRepo from "../../github/GitHubRepo";

const personal = {
  id: 1,
  account_type: "personal",
  scope: "personal",
  effective_role: "owner",
};
const orgUser = (effective_role: string) => ({
  id: 2,
  account_type: "organization",
  scope: "organization",
  effective_role,
});

const project = (id: number, owner: string, name: string) => ({
  id,
  name,
  github_owner: owner,
  github_repo: name,
});
const ghRepo = (full_name: string, isPrivate = false) => ({
  full_name,
  name: full_name.split("/")[1],
  owner: { login: full_name.split("/")[0] },
  private: isPrivate,
});

// The viewer looks the new project up again, so the server must list it too.
const createdOnServer = (row: ReturnType<typeof project>) =>
  createProject.mockImplementation(async () => {
    listProjects.mockResolvedValue([row]);
    return row;
  });

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/github"]}>
      <Routes>
        <Route path="/github" element={<GitHubRepo />} />
      </Routes>
    </MemoryRouter>
  );

// Back from connecting GitHub with repositories already added, the add dialog
// opens on its import tab; `tab` switches it first.
const openDialog = async (tab?: "Clone URL") => {
  window.location.hash = "#connected=true";
  renderPage();
  const dialog = within(await screen.findByRole("dialog"));
  if (tab) await userEvent.click(dialog.getByRole("tab", { name: tab }));
  return dialog;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.location.hash = "";
  mockUser = personal;
  listProjects.mockResolvedValue([project(7, "acme", "api")]);
  listImportableRepos.mockResolvedValue({ connected: true, repos: [] });
  getGithubConnection.mockResolvedValue({ connected: true, login: "me" });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).includes("/actions/runs")
              ? { workflow_runs: [], total_count: 0 }
              : []
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    )
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("cloning by URL", () => {
  it("adds the pasted clone command and switches to the new repository", async () => {
    createdOnServer(project(8, "acme", "web"));
    const dialog = await openDialog("Clone URL");

    await userEvent.type(
      dialog.getByLabelText("Repository URL"),
      "git clone git@github.com:acme/web.git"
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Add repository" })
    );

    expect(createProject).toHaveBeenCalledWith(
      "web",
      "git@github.com:acme/web.git"
    );
    expect(
      await screen.findByRole("button", { name: /acme\/web$/ })
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a repository that's already added", async () => {
    const dialog = await openDialog("Clone URL");

    await userEvent.type(
      dialog.getByLabelText("Repository URL"),
      "https://github.com/ACME/api.git"
    );
    await userEvent.click(
      dialog.getByRole("button", { name: "Add repository" })
    );

    expect(createProject).not.toHaveBeenCalled();
    expect(dialog.getByRole("alert").textContent).toContain("already added");
  });

  it("stays open with the server's reason when it can't be added", async () => {
    createProject.mockRejectedValue(new Error("Repository not found"));
    const dialog = await openDialog("Clone URL");

    await userEvent.type(dialog.getByLabelText("Repository URL"), "acme/gone");
    await userEvent.click(
      dialog.getByRole("button", { name: "Add repository" })
    );

    expect((await dialog.findByRole("alert")).textContent).toContain(
      "Repository not found"
    );
  });
});

describe("importing from GitHub", () => {
  it("imports one repository, marking the ones already added", async () => {
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [ghRepo("acme/api"), ghRepo("me/secret", true)],
    });
    createdOnServer(project(9, "me", "secret"));
    const dialog = await openDialog();

    const added = (await dialog.findByText("acme/api")).closest("li");
    expect(within(added as HTMLElement).getByText("Added")).toBeTruthy();
    const row = dialog.getByText(/me\/secret/).closest("li");
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Import" })
    );

    expect(createProject).toHaveBeenCalledWith(
      "secret",
      "https://github.com/me/secret"
    );
    expect(
      await screen.findByRole("button", { name: /me\/secret$/ })
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("prompts to connect GitHub when a personal account hasn't", async () => {
    listImportableRepos.mockResolvedValue({ connected: false, repos: [] });
    getGithubConnection.mockResolvedValue({ connected: false });
    listProjects.mockResolvedValue([]);
    renderPage();

    await userEvent.click(
      await screen.findByRole("tab", { name: "Import from GitHub" })
    );

    expect(
      await screen.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
  });

  it("returns to the import list after connecting", async () => {
    window.location.hash = "#connected=true";
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [ghRepo("me/new")],
    });
    renderPage();

    expect(await screen.findByText("me/new")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("imports everything on a first connect with no repositories yet", async () => {
    window.location.hash = "#connected=true";
    listProjects.mockResolvedValue([]);
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [ghRepo("me/new")],
    });
    createdOnServer(project(10, "me", "new"));
    renderPage();

    expect(
      await screen.findByRole("button", { name: /me\/new$/ })
    ).toBeTruthy();
    expect(createProject).toHaveBeenCalledWith(
      "new",
      "https://github.com/me/new"
    );
  });

  it("can disconnect GitHub", async () => {
    disconnectGithub.mockResolvedValue(undefined);
    const dialog = await openDialog();

    await userEvent.click(
      await dialog.findByRole("button", { name: "Disconnect" })
    );

    expect(disconnectGithub).toHaveBeenCalled();
    expect(
      await dialog.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
  });
});

describe("with no repositories yet", () => {
  it("offers both ways straight away", async () => {
    listProjects.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByLabelText("Repository URL")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Import from GitHub" })
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives an organization member only a hint", async () => {
    mockUser = orgUser("member");
    listProjects.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("who gets to add", () => {
  it("lets an organization owner, with private repos once GitHub is connected", async () => {
    mockUser = orgUser("owner");
    listProjects.mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(
        /Private repositories work once your organization connects GitHub/
      )
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Import from GitHub" })
    ).toBeTruthy();
  });

  it.each([
    ["a personal account", personal],
    ["an organization owner", orgUser("owner")],
    ["an organization member", orgUser("member")],
  ])("has no + Add in the menu for %s", async (_who, who) => {
    mockUser = who;
    renderPage();
    await screen.findByRole("button", { name: /^Select a repository/ });
    expect(screen.queryByRole("button", { name: "+ Add" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a project without a repository", () => {
  const unlinked = {
    id: 9,
    name: "three",
    github_owner: null,
    github_repo: null,
  };

  it("isn't what opens when another project has code", async () => {
    mockUser = orgUser("owner");
    // Newest first, as the server lists them.
    listProjects.mockResolvedValue([unlinked, project(7, "acme", "api")]);
    renderPage();

    const picker = await screen.findByRole("button", {
      name: /^Select a repository/,
    });
    expect(picker.textContent).toContain("acme/api");
    expect(screen.queryByText("Add a repository")).toBeNull();
  });

  it("keeps the repository picker, so another project can be opened", async () => {
    mockUser = orgUser("owner");
    listProjects.mockResolvedValue([unlinked]);
    renderPage();

    expect(await screen.findByText("Add a repository")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Select a repository/ })
    ).toBeTruthy();
  });

  it("says when a pasted URL is an account, not a repository", async () => {
    mockUser = orgUser("owner");
    listProjects.mockResolvedValue([unlinked]);
    renderPage();

    await userEvent.type(
      await screen.findByPlaceholderText("https://github.com/owner/repo"),
      "https://github.com/mahesivaya"
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add repository" })
    );
    expect(
      await screen.findByText(/That's the GitHub account "mahesivaya"/)
    ).toBeTruthy();
  });
});

describe("a repository added elsewhere", () => {
  it("shows in the open Code & reviews picker without a reload", async () => {
    mockUser = orgUser("owner");
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Select a repository/ })
    );
    expect(screen.queryByText("acme/web")).toBeNull();
    await userEvent.keyboard("{Escape}");

    // Imported from Settings → Repositories while this page stays open.
    listProjects.mockResolvedValue([
      project(8, "acme", "web"),
      project(7, "acme", "api"),
    ]);
    window.dispatchEvent(new CustomEvent("rwayve:projects-changed"));

    await userEvent.click(
      screen.getByRole("button", { name: /^Select a repository/ })
    );
    expect(await screen.findByText("acme/web")).toBeTruthy();
  });
});

describe("live pull requests", () => {
  const pullListCalls = () =>
    (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([url]) => String(url).includes("/pulls?state=")
    ).length;

  it("reloads the open repo's pull requests on a github:pulls event", async () => {
    mockUser = orgUser("owner");
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    renderPage();
    await screen.findByRole("button", { name: /^Select a repository/ });
    await vi.waitFor(() => expect(pullListCalls()).toBeGreaterThan(0));
    const before = pullListCalls();

    // Another repo's activity changes nothing.
    window.dispatchEvent(
      new CustomEvent("rwayve:github-event", {
        detail: { type: "github:pulls", repo: "acme/web", number: 1 },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(pullListCalls()).toBe(before);

    // This repo's (any case): the list and the open/closed counts reload.
    window.dispatchEvent(
      new CustomEvent("rwayve:github-event", {
        detail: { type: "github:pulls", repo: "ACME/api", number: 3 },
      })
    );
    await vi.waitFor(() => expect(pullListCalls()).toBe(before + 3), {
      timeout: 2000,
    });
  });
});
