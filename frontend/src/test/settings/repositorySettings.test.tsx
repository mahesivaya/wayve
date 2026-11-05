// Settings > Repositories: adding by URL or import creates the linked project
// that Code Repo shows, and each account type only gets what it may do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mockAuth: { user: Record<string, unknown> | null; logout: () => void } = {
  user: null,
  logout: vi.fn(),
};
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockAuth }));

const listProjects = vi.fn();
const createProject = vi.fn();
const deleteProject = vi.fn();
vi.mock("../../api/workspace", () => ({
  listProjects: () => listProjects(),
  createProject: (name: string, url: string) => createProject(name, url),
  deleteProject: (id: number) => deleteProject(id),
}));

const listImportableRepos = vi.fn();
const getGithubConnection = vi.fn();
const getGithubConnectUrl = vi.fn();
const getVisibleProjects = vi.fn();
vi.mock("../../api/github", () => ({
  listImportableRepos: () => listImportableRepos(),
  getGithubConnection: () => getGithubConnection(),
  getGithubConnectUrl: () => getGithubConnectUrl(),
  getVisibleProjects: () => getVisibleProjects(),
}));

import RepositorySettings from "../../settings/RepositorySettings";

const repo = (full_name: string, isPrivate = false) => ({
  full_name,
  name: full_name.split("/")[1],
  private: isPrivate,
});
const project = (id: number, owner: string | null, name: string) => ({
  id,
  name,
  github_owner: owner,
  github_repo: owner ? name : null,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <RepositorySettings />
    </MemoryRouter>
  );

const personal = { id: 1, account_type: "personal", scope: "personal" };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = personal;
  listProjects.mockResolvedValue([]);
  listImportableRepos.mockResolvedValue({ connected: true, repos: [] });
  getGithubConnection.mockResolvedValue({ connected: true, login: "me" });
});
afterEach(cleanup);

describe("adding by URL", () => {
  it("links a clone URL and lists it with a way into Code Repo", async () => {
    createProject.mockResolvedValue(project(7, "acme", "api"));
    renderPage();

    await userEvent.type(
      await screen.findByLabelText("Repository URL"),
      "git clone git@github.com:acme/api.git"
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add repository" })
    );

    expect(createProject).toHaveBeenCalledWith(
      "api",
      "git@github.com:acme/api.git"
    );
    const open = await screen.findByRole("link", {
      name: "Open in Code Repo",
    });
    expect(open.getAttribute("href")).toBe("/github/7");
  });

  it("refuses a repository that's already added, whatever the URL form", async () => {
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    renderPage();
    await screen.findByText("acme/api");

    await userEvent.type(
      screen.getByLabelText("Repository URL"),
      "https://github.com/ACME/api.git"
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add repository" })
    );

    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("already added");
  });

  it("shows the server's reason when a repository can't be added", async () => {
    createProject.mockRejectedValue(new Error("Repository not found"));
    renderPage();
    await userEvent.type(
      await screen.findByLabelText("Repository URL"),
      "acme/missing"
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add repository" })
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Repository not found"
    );
  });
});

describe("importing from GitHub", () => {
  it("prompts a personal account to connect first", async () => {
    listImportableRepos.mockResolvedValue({ connected: false, repos: [] });
    getGithubConnection.mockResolvedValue({ connected: false });
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
  });

  it("imports one repository and marks those already added", async () => {
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("acme/api"), repo("me/secret", true)],
    });
    createProject.mockResolvedValue(project(8, "me", "secret"));
    renderPage();

    const row = (await screen.findByText(/me\/secret/)).closest("li");
    expect(within(row as HTMLElement).getByText("Private")).toBeTruthy();
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Import" })
    );

    expect(createProject).toHaveBeenCalledWith(
      "secret",
      "https://github.com/me/secret"
    );
    expect((await screen.findAllByText("Added")).length).toBe(2);
    expect(
      screen.getByRole("button", { name: "Import all (0)" })
    ).toHaveProperty("disabled", true);
  });

  it("imports everything not yet added", async () => {
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("a/one"), repo("a/two")],
    });
    createProject.mockImplementation(async (name: string) =>
      project(name === "one" ? 1 : 2, "a", name)
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Import all (2)" })
    );
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(
      await screen.findAllByRole("link", { name: "Open in Code Repo" })
    ).toHaveLength(2);
  });
});

describe("removing", () => {
  it("asks first, then removes", async () => {
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    deleteProject.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    renderPage();
    const button = await screen.findByRole("button", {
      name: "Remove acme/api",
    });

    await userEvent.click(button);
    expect(deleteProject).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await userEvent.click(button);
    expect(deleteProject).toHaveBeenCalledWith(7);
    expect(await screen.findByText("No repositories added yet.")).toBeTruthy();
    confirm.mockRestore();
  });

  it("leaves out projects with no repository", async () => {
    listProjects.mockResolvedValue([project(9, null, "Planning")]);
    renderPage();
    expect(await screen.findByText("No repositories added yet.")).toBeTruthy();
    expect(screen.queryByText("Planning")).toBeNull();
  });
});

describe("who gets what", () => {
  it("lets an organization owner add", async () => {
    mockAuth.user = {
      id: 2,
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
    };
    renderPage();
    expect(await screen.findByLabelText("Repository URL")).toBeTruthy();
    expect(getGithubConnection).not.toHaveBeenCalled();
  });

  it("gives other organization roles a read-only list", async () => {
    mockAuth.user = {
      id: 3,
      account_type: "organization",
      scope: "organization",
      effective_role: "admin",
    };
    listProjects.mockResolvedValue([project(7, "acme", "api")]);
    renderPage();

    expect(await screen.findByText("acme/api")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open in Code Repo" })
    ).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(listImportableRepos).not.toHaveBeenCalled();
  });

  it("shows platform staff their repositories, opened by name", async () => {
    mockAuth.user = {
      id: 4,
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "member",
    };
    getVisibleProjects.mockResolvedValue({
      unrestricted: false,
      repos: [repo("acme/api")],
    });
    renderPage();

    const open = await screen.findByRole("link", {
      name: "Open in Code Repo",
    });
    expect(open.getAttribute("href")).toBe("/github?owner=acme&repo=api");
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("offers a platform owner Connect GitHub", async () => {
    mockAuth.user = {
      id: 5,
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "owner",
    };
    getGithubConnection.mockResolvedValue({ connected: false });
    renderPage();
    expect(
      await screen.findByRole("button", {
        name: "Connect GitHub to add your repositories",
      })
    ).toBeTruthy();
  });

  it("keeps guests out", () => {
    mockAuth.user = { ...personal, effective_role: "guest" };
    renderPage();
    expect(screen.getByText(/Guests don't have access/)).toBeTruthy();
    expect(listProjects).not.toHaveBeenCalled();
  });
});
