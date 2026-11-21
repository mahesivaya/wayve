// The GitHub panel on Integrations: an organization connects through the Hadal
// GitHub App (owner only), everyone else through their own GitHub sign-in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mockAuth: { user: Record<string, unknown> | null } = { user: null };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockAuth }));

const getGithubConnection = vi.fn();
const getGithubConnectUrl = vi.fn();
const disconnectGithub = vi.fn();
const getGithubAppStatus = vi.fn();
const getGithubAppInstallUrl = vi.fn();
const disconnectGithubApp = vi.fn();
vi.mock("../../api/github", () => ({
  getGithubConnection: () => getGithubConnection(),
  getGithubConnectUrl: () => getGithubConnectUrl(),
  disconnectGithub: () => disconnectGithub(),
  getGithubAppStatus: () => getGithubAppStatus(),
  getGithubAppInstallUrl: () => getGithubAppInstallUrl(),
  disconnectGithubApp: () => disconnectGithubApp(),
}));

import GitHubPanel from "../../integrations/GitHubPanel";

const org = (role: string) => ({
  id: 2,
  scope: "organization",
  account_type: role === "owner" ? "organization_admin" : "organization",
  effective_role: role,
});

const renderPanel = () =>
  render(
    <MemoryRouter>
      <GitHubPanel />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  getGithubAppStatus.mockResolvedValue({ configured: true, connected: false });
  getGithubConnection.mockResolvedValue({ connected: false });
});
afterEach(cleanup);

describe("an organization", () => {
  it("lets the owner connect by installing the GitHub App", async () => {
    mockAuth.user = org("owner");
    getGithubAppInstallUrl.mockResolvedValue("#installing");
    renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" })
    );
    expect(getGithubAppInstallUrl).toHaveBeenCalledTimes(1);
    expect(getGithubConnectUrl).not.toHaveBeenCalled();
    expect(getGithubConnection).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("link", { name: "Settings → Repositories" })
        .getAttribute("href")
    ).toBe("/settings/repositories");
  });

  it("shows the owner the connected account, its repositories and Disconnect", async () => {
    mockAuth.user = org("owner");
    getGithubAppStatus.mockResolvedValue({
      configured: true,
      connected: true,
      account_login: "acme",
      manage_url:
        "https://github.com/organizations/acme/settings/installations/7",
    });
    disconnectGithubApp.mockResolvedValue({ disconnected: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();

    expect(await screen.findByText("@acme")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Choose repositories" })
        .getAttribute("href")
    ).toBe("https://github.com/organizations/acme/settings/installations/7");
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnectGithubApp).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Not connected")).toBeTruthy();
    confirm.mockRestore();
  });

  it("gives other members the status, not the controls", async () => {
    mockAuth.user = org("member");
    renderPanel();

    expect(
      await screen.findByText(
        /Only your organization's owner can connect GitHub/
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });

  it("says so when the server has no GitHub App", async () => {
    mockAuth.user = org("owner");
    getGithubAppStatus.mockResolvedValue({
      configured: false,
      connected: false,
    });
    renderPanel();

    expect(
      await screen.findByText(
        /Connecting GitHub isn't set up on this server yet/
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });
});

it("keeps a personal account on its own GitHub sign-in", async () => {
  mockAuth.user = { id: 1, scope: "personal", account_type: "personal" };
  getGithubConnectUrl.mockResolvedValue("#connecting");
  renderPanel();

  await userEvent.click(
    await screen.findByRole("button", { name: "Connect GitHub" })
  );
  expect(getGithubConnectUrl).toHaveBeenCalledTimes(1);
  expect(getGithubAppStatus).not.toHaveBeenCalled();
});
