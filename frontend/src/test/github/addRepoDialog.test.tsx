// Code Repo's "+ Add": clone by URL or import from GitHub, without leaving for
// Settings. Only those the server lets add repositories get it.
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

const openDialog = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "+ Add" }));
  return within(await screen.findByRole("dialog"));
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
    renderPage();
    const dialog = await openDialog();

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
    renderPage();
    const dialog = await openDialog();

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
    renderPage();
    const dialog = await openDialog();

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
    renderPage();
    const dialog = await openDialog();
    expect(listImportableRepos).not.toHaveBeenCalled();

    await userEvent.click(
      dialog.getByRole("tab", { name: "Import from GitHub" })
    );
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
    renderPage();
    const dialog = await openDialog();

    await userEvent.click(
      dialog.getByRole("tab", { name: "Import from GitHub" })
    );

    expect(
      await dialog.findByRole("button", { name: "Connect GitHub" })
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
    renderPage();
    const dialog = await openDialog();
    await userEvent.click(
      dialog.getByRole("tab", { name: "Import from GitHub" })
    );

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
  it("lets an organization owner, limited to public repositories", async () => {
    mockUser = orgUser("owner");
    renderPage();
    const dialog = await openDialog();
    expect(
      dialog.getByText(/Organization repositories must be public/)
    ).toBeTruthy();
    expect(
      dialog.getByRole("tab", { name: "Import from GitHub" })
    ).toBeTruthy();
  });

  it("doesn't offer it to an organization member", async () => {
    mockUser = orgUser("member");
    renderPage();
    await screen.findByRole("button", { name: /^Select a repository/ });
    expect(screen.queryByRole("button", { name: "+ Add" })).toBeNull();
  });
});
