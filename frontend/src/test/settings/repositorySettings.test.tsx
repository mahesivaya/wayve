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
const getGithubAppStatus = vi.fn();
const getGithubAppInstallUrl = vi.fn();
const disconnectGithubApp = vi.fn();
vi.mock("../../api/github", () => ({
  listImportableRepos: () => listImportableRepos(),
  getGithubConnection: () => getGithubConnection(),
  getGithubConnectUrl: () => getGithubConnectUrl(),
  getVisibleProjects: () => getVisibleProjects(),
  getGithubAppStatus: () => getGithubAppStatus(),
  getGithubAppInstallUrl: () => getGithubAppInstallUrl(),
  disconnectGithubApp: () => disconnectGithubApp(),
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
  getGithubAppStatus.mockResolvedValue({ configured: true, connected: false });
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const orgOwner = {
  id: 2,
  account_type: "organization_admin",
  scope: "organization",
  effective_role: "owner",
};

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

describe("an organization's GitHub", () => {
  beforeEach(() => {
    mockAuth.user = orgOwner;
  });

  it("is connected by installing the GitHub App, not a personal sign-in", async () => {
    listImportableRepos.mockResolvedValue({ connected: false, repos: [] });
    getGithubAppInstallUrl.mockResolvedValue("#installing");
    renderPage();

    expect(
      await screen.findByText(/install the Hadal GitHub App/)
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" })
    );
    expect(getGithubAppInstallUrl).toHaveBeenCalledTimes(1);
    expect(getGithubConnectUrl).not.toHaveBeenCalled();
    expect(getGithubConnection).not.toHaveBeenCalled();
  });

  it("lists the shared repositories, private ones included, once connected", async () => {
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("acme/secret", true)],
    });
    getGithubAppStatus.mockResolvedValue({
      configured: true,
      connected: true,
      account_login: "acme",
      manage_url:
        "https://github.com/organizations/acme/settings/installations/7",
    });
    renderPage();

    expect(
      await screen.findByText(/Connected to GitHub as @acme/)
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Choose repositories" })
        .getAttribute("href")
    ).toBe("https://github.com/organizations/acme/settings/installations/7");
    const row = (await screen.findByText("acme/secret")).closest("li")!;
    expect(within(row).getByText("Private")).toBeTruthy();
  });

  it("asks before disconnecting, then disconnects the organization", async () => {
    listImportableRepos.mockResolvedValue({
      connected: true,
      repos: [repo("acme/secret", true)],
    });
    getGithubAppStatus.mockResolvedValue({
      configured: true,
      connected: true,
      account_login: "acme",
    });
    disconnectGithubApp.mockResolvedValue({ disconnected: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "Disconnect" })
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(disconnectGithubApp).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
    confirm.mockRestore();
  });

  it("explains a failed install and cleans up the address", async () => {
    history.replaceState(
      null,
      "",
      "/settings/repositories#github_app_error=not_your_installation"
    );
    listImportableRepos.mockResolvedValue({ connected: false, repos: [] });
    renderPage();

    expect(
      await screen.findByText(
        "That GitHub installation isn't one your GitHub account can see."
      )
    ).toBeTruthy();
    expect(window.location.hash).toBe("");
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

describe("the code settings", () => {
  it("are on this page for every account that can see code", async () => {
    renderPage();
    expect(await screen.findByLabelText("Code theme")).toBeTruthy();
    cleanup();

    mockAuth.user = {
      id: 4,
      account_type: "platform_admin",
      scope: "platform",
      effective_role: "member",
    };
    getVisibleProjects.mockResolvedValue({ unrestricted: false, repos: [] });
    renderPage();
    expect(await screen.findByLabelText("Code theme")).toBeTruthy();
  });

  it("aren't shown to guests, who can't see code", () => {
    mockAuth.user = { ...personal, effective_role: "guest" };
    renderPage();
    expect(screen.queryByLabelText("Code theme")).toBeNull();
  });
});

describe("who gets what", () => {
  it("lets an organization owner add", async () => {
    mockAuth.user = orgOwner;
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
