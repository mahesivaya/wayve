// The wide-screen sidebar's Settings gear opens a small menu instead of going
// straight to Settings: Settings, plus Platform admin for users who can open a
// Platform page.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 7, email: "owner@test.local" },
    logout: vi.fn(),
  }),
}));

import ProfileMenu from "../../components/ProfileMenu";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const renderGear = (platformAdminPath?: string) =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <ProfileMenu
        placement="sidebar"
        minimal
        platformAdminPath={platformAdminPath}
      />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

describe("Settings gear menu", () => {
  it("opens a menu instead of navigating", () => {
    renderGear("/platform/members");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("where").textContent).toBe("/home");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Platform admin" })
    ).toBeTruthy();
  });

  it("goes to Settings from the menu and closes it", () => {
    renderGear("/platform/members");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("goes to the first Platform page from Platform admin", () => {
    renderGear("/platform/billing");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Platform admin" }));
    expect(screen.getByTestId("where").textContent).toBe("/platform/billing");
  });

  it("hides Platform admin without a Platform page, and closes on Escape", () => {
    renderGear(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.queryByRole("menuitem", { name: "Platform admin" })
    ).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
