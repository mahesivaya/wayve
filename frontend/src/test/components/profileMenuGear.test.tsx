// The wide-screen sidebar's account row (profile picture + username or email)
// opens a small menu: Settings, Platform admin (platform admins only) and Log
// out.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const logout = vi.fn();
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 7, email: "owner@test.local" },
    logout,
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

describe("Account menu", () => {
  it("shows the email when there is no username", () => {
    renderGear();
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toContain("owner@test.local");
    expect(trigger.textContent).not.toContain("Settings");
  });

  it("opens a menu instead of navigating", () => {
    renderGear("/platform/members");
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByTestId("where").textContent).toBe("/home");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Platform admin" })
    ).toBeTruthy();
  });

  it("goes to Settings from the menu and closes it", () => {
    renderGear("/platform/members");
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("goes to the first Platform page from Platform admin", () => {
    renderGear("/platform/billing");
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Platform admin" }));
    expect(screen.getByTestId("where").textContent).toBe("/platform/billing");
  });

  it("hides Platform admin without a Platform page, and closes on Escape", () => {
    renderGear(undefined);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(
      screen.queryByRole("menuitem", { name: "Platform admin" })
    ).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists Log out under Platform admin, and logs out", () => {
    renderGear("/platform/members");
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Settings", "Platform admin", "Log out"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
