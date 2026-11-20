// The wide-screen sidebar's account row (profile picture + username or email)
// opens a small menu: Settings and Log out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

const renderGear = () =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <ProfileMenu placement="sidebar" minimal />
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

  it("shows the email's name part, not the domain, when there is no username", () => {
    renderGear();
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toContain("owner");
    expect(trigger.textContent).not.toContain("@test.local");
    expect(trigger.textContent).not.toContain("Settings");
  });

  it("opens a menu instead of navigating", () => {
    renderGear();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByTestId("where").textContent).toBe("/home");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  });

  it("opens the user's profile from Settings and closes the menu", () => {
    renderGear();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings/account");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("has no Platform admin item, and closes on Escape", () => {
    renderGear();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(
      screen.queryByRole("menuitem", { name: "Platform admin" })
    ).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists Log out under Settings, and logs out", () => {
    renderGear();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["Settings", "Log out"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows your status on the avatar but not as menu choices", async () => {
    renderGear();
    // Seeded from the server (the presence snapshot says "away").
    expect(
      await screen.findByRole("img", { name: "Status: Away" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.queryByText("Do Not Disturb")).toBeNull();
    expect(setChatStatus).not.toHaveBeenCalled();
  });
});
