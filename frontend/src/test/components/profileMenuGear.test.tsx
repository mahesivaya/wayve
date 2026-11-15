// The wide-screen sidebar's account row (profile picture + username or email)
// opens a small menu: Settings, Platform admin (platform admins only) and Log
// out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const logout = vi.fn();
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 7, email: "owner@test.local" },
    logout,
  }),
}));

// Status reads and writes go through the chat API; keep them off the network.
const getPresence = vi.fn(async () => [
  { user_id: 7, online: true, last_seen: null, status: "away" as const },
]);
const setChatStatus = vi.fn(async () => undefined);
vi.mock("../../api/chat", () => ({
  getPresence: (...a: unknown[]) => getPresence(...(a as [])),
  setChatStatus: (...a: unknown[]) => setChatStatus(...(a as [])),
}));

import ProfileMenu from "../../components/ProfileMenu";
import { resetMyStatusForTests } from "../../chat/myStatus";

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
  beforeEach(() => {
    resetMyStatusForTests();
    setChatStatus.mockClear();
  });

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

  it("shows your status on the avatar and lists the three choices", async () => {
    renderGear();
    // Seeded from the server (the presence snapshot says "away").
    expect(
      await screen.findByRole("img", { name: "Status: Away" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((c) => c.textContent?.replace("✓", "").trim())).toEqual([
      "Active",
      "Do Not Disturb",
      "Away",
    ]);
    expect(
      screen
        .getByRole("menuitemradio", { name: /Away/ })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("sets a status from the menu, saves it and closes", async () => {
    renderGear();
    await screen.findByRole("img", { name: "Status: Away" });
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Do Not Disturb/ })
    );
    expect(setChatStatus).toHaveBeenCalledWith("dnd");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Status: Do Not Disturb" })
      ).toBeTruthy()
    );
  });
});
