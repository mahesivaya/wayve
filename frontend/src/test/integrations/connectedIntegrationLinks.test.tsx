// The settings menu lists the connected services under "Integrations", each
// opening the Integrations page on that service.
import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, scope: "organization", permissions: [] },
  }),
}));
const connected = vi.hoisted(
  () => (value: boolean) => () => Promise.resolve({ connected: value })
);
vi.mock("../../api/jira", () => ({ getJiraConnection: connected(true) }));
vi.mock("../../api/github", () => ({
  getGithubConnection: connected(false),
  getGithubAppStatus: connected(false),
}));
vi.mock("../../api/gitlab", () => ({ getGitlabConnection: connected(true) }));
vi.mock("../../api/figma", () => ({ getFigmaConnection: connected(false) }));
const getSlackConnection = vi.hoisted(() => vi.fn());
vi.mock("../../api/slack", () => ({ getSlackConnection }));
const getMcpConnections = vi.hoisted(() => vi.fn());
vi.mock("../../api/mcp", () => ({ getMcpConnections }));
vi.mock("../../api/email", () => ({ getAccounts: () => Promise.resolve([]) }));

import ConnectedIntegrationLinks from "../../integrations/ConnectedIntegrationLinks";

it("links each connected service, and only those", async () => {
  render(
    <MemoryRouter initialEntries={["/integrations?service=gitlab"]}>
      <ConnectedIntegrationLinks />
    </MemoryRouter>
  );

  const jira = await screen.findByRole("link", { name: "Jira" });
  expect(jira.getAttribute("href")).toBe("/integrations?service=jira");
  const gitlab = await screen.findByRole("link", { name: "GitLab" });
  // The service whose panel is open is the lit row.
  expect(gitlab.className).toContain("active");
  expect(jira.className).not.toContain("active");
  expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Figma" })).toBeNull();
  // Not an enterprise org, and no MCP rights: neither is even asked about.
  expect(getSlackConnection).not.toHaveBeenCalled();
  expect(getMcpConnections).not.toHaveBeenCalled();
});
