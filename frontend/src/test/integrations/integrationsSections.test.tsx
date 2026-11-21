// Settings › Integrations lists the connected services first, in their own
// card, with everything else below.
import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@test.local",
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
      permissions: [],
    },
  }),
}));
const connected = (value: boolean) => () =>
  Promise.resolve({ connected: value });
vi.mock("../../api/jira", () => ({ getJiraConnection: connected(true) }));
vi.mock("../../api/github", () => ({
  getGithubConnection: connected(false),
  // An organization: GitHub is connected through the GitHub App.
  getGithubAppStatus: connected(true),
}));
vi.mock("../../api/gitlab", () => ({ getGitlabConnection: connected(false) }));
vi.mock("../../api/slack", () => ({ getSlackConnection: connected(false) }));
vi.mock("../../api/figma", () => ({ getFigmaConnection: connected(false) }));
vi.mock("../../api/mcp", () => ({
  getMcpConnections: () => Promise.resolve([]),
}));
vi.mock("../../api/email", () => ({ getAccounts: () => Promise.resolve([]) }));
for (const panel of [
  "../../integrations/SlackPanel",
  "../../integrations/FigmaPanel",
  "../../integrations/McpPanel",
  "../../integrations/GitLabPanel",
  "../../integrations/GitHubPanel",
  "../../integrations/GmailPanel",
  "../../tasks/JiraPanel",
]) {
  vi.doMock(panel, () => ({ default: () => null }));
}

it("puts connected services in a card above the rest", async () => {
  const { default: Integrations } =
    await import("../../integrations/Integrations");
  render(
    <MemoryRouter>
      <Integrations />
    </MemoryRouter>
  );

  const connectedHeading = await screen.findByRole("heading", {
    name: "Connected",
  });
  const otherHeading = screen.getByRole("heading", {
    name: "Connect a service",
  });
  expect(
    connectedHeading.compareDocumentPosition(otherHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();

  const card = (heading: HTMLElement) =>
    within(heading.closest("section") as HTMLElement);
  expect(card(connectedHeading).getByText("Jira")).toBeTruthy();
  expect(card(connectedHeading).getByText("GitHub")).toBeTruthy();
  expect(card(connectedHeading).queryByText("GitLab")).toBeNull();
  expect(card(otherHeading).getByText("GitLab")).toBeTruthy();
  expect(card(otherHeading).queryByText("Jira")).toBeNull();
});

it("opens a service's panel and scrolls to it, since panels sit below the tiles", async () => {
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  try {
    const { default: Integrations } =
      await import("../../integrations/Integrations");
    render(
      <MemoryRouter>
        <Integrations />
      </MemoryRouter>
    );

    await userEvent.click(
      await screen.findByRole("button", { name: /GitLab/ })
    );
    expect(await screen.findByRole("heading", { name: "GitLab" })).toBeTruthy();
    expect(scrolled).toContain("integration-panel-gitlab");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});
