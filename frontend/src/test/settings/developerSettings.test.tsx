// The Developers group moved out of the main sidebar into the settings family.
// These cover what that move has to preserve: the visibility rules the sidebar
// group carried, and the rail entry that replaces it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

type TestUser = {
  id: number;
  email: string;
  account_type: string;
  scope?: string;
  effective_role?: string;
};

let currentUser: TestUser = {
  id: 1,
  email: "owner@test.local",
  account_type: "organization",
  scope: "organization",
  effective_role: "owner",
};

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: currentUser,
    logout: vi.fn(),
    switchMode: vi.fn(),
  }),
}));

import DeveloperSettings from "../../profile/DeveloperSettings";

const renderPage = () =>
  render(
    <MemoryRouter>
      <DeveloperSettings />
    </MemoryRouter>
  );

describe("Developers settings page", () => {
  beforeEach(() => {
    currentUser = {
      id: 1,
      email: "owner@test.local",
      account_type: "organization",
      scope: "organization",
      effective_role: "owner",
    };
  });

  it("lists the developer references the sidebar group used to hold", () => {
    renderPage();
    expect(screen.getByText("API reference")).toBeTruthy();
    expect(screen.getByText("Libraries & SDK")).toBeTruthy();
    expect(screen.getByText("API keys")).toBeTruthy();
  });

  it("keeps Docs to platform scope, as the sidebar group did", () => {
    renderPage();
    expect(screen.queryByText("Docs")).toBeNull();
  });

  it("shows Docs for a platform-scope user", () => {
    currentUser = { ...currentUser, scope: "platform" };
    renderPage();
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  // `canAccessApiKeyAdmin` is the admin-UI gate, stricter than the raw
  // `api_keys:manage` permission — Developer holds that for its own keys but
  // must not see the admin surface.
  it("keeps API keys behind its role gate", () => {
    currentUser = { ...currentUser, effective_role: "developer" };
    renderPage();
    expect(screen.queryByText("API keys")).toBeNull();
    // The rest of the page still stands — only the gated row drops out.
    expect(screen.getByText("API reference")).toBeTruthy();
  });
});
