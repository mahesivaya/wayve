// The platform API catalogue (/platform/api): the endpoint list the "API" card
// on the platform home opens. It renders whatever the backend's OpenAPI
// document declares, so the tests here pin the parse (verbs, tags, scopes) and
// the filter — not any particular endpoint the spec happens to carry today.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const user = {
  id: 1,
  email: "owner@fluxze.com",
  scope: "platform",
  account_type: "platform_admin",
  effective_role: "owner",
  permissions: ["members:read", "api_keys:manage"],
};

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user }),
}));

const getApiCatalogue = vi.fn();
vi.mock("../../api/openapi", () => ({
  getApiCatalogue: () => getApiCatalogue(),
}));

import PlatformApis from "../../organization/PlatformApis";

const catalogue = {
  title: "Wayve API",
  version: "2026.05",
  groups: { Emails: "Read messages, send mail.", Notes: "Personal notes." },
  endpoints: [
    {
      method: "GET",
      path: "/api/emails",
      tag: "Emails",
      operationId: "listEmails",
      summary: "Inbox, paginated",
      scope: "email:read",
    },
    {
      method: "POST",
      path: "/api/emails",
      tag: "Emails",
      operationId: "sendEmail",
      summary: "Send a new message",
      scope: "email:send",
    },
    {
      method: "GET",
      path: "/api/notes",
      tag: "Notes",
      operationId: "listNotes",
      summary: "All notes",
      scope: "notes:read",
    },
  ],
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <PlatformApis />
    </MemoryRouter>
  );

describe("PlatformApis", () => {
  beforeEach(() => {
    getApiCatalogue.mockReset();
    getApiCatalogue.mockResolvedValue(catalogue);
  });

  it("lists every endpoint, grouped by area", async () => {
    renderPage();

    // GET and POST on the same path are two rows, not one.
    expect(await screen.findAllByText("/api/emails")).toHaveLength(2);
    expect(screen.getByText("/api/notes")).toBeTruthy();
    expect(
      screen.getAllByText("GET", { selector: ".api-method" })
    ).toHaveLength(2);
    expect(
      screen.getAllByText("POST", { selector: ".api-method" })
    ).toHaveLength(1);
    // Tag headings come from the spec's tag list.
    expect(screen.getByRole("heading", { name: "Emails" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
    expect(screen.getByText("3 endpoints")).toBeTruthy();
  });

  it("reveals the scope when a row is expanded", async () => {
    renderPage();
    const row = await screen.findByText("/api/notes");

    // Collapsed: the scope is not on screen.
    expect(screen.queryByText("notes:read")).toBeNull();

    await userEvent.click(row);

    expect(screen.getByText("notes:read")).toBeTruthy();
    expect(screen.getByText("listNotes")).toBeTruthy();
  });

  it("filters on path, verb and scope", async () => {
    renderPage();
    await screen.findAllByText("/api/emails");

    await userEvent.type(
      screen.getByLabelText("Filter endpoints"),
      "notes:read"
    );

    expect(screen.getByText("/api/notes")).toBeTruthy();
    expect(screen.queryAllByText("/api/emails")).toHaveLength(0);
    expect(screen.getByText("1 of 3 endpoints")).toBeTruthy();
  });

  it("surfaces a failed load instead of rendering an empty list", async () => {
    getApiCatalogue.mockRejectedValue(new Error("spec unavailable"));
    renderPage();

    expect(await screen.findByText("spec unavailable")).toBeTruthy();
  });
});
