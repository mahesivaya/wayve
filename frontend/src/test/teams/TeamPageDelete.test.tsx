// "Delete team" on the team page: owner-only (same rule as creating a team),
// never offered for a display-only sample team, and a confirmed delete calls
// the API and leaves the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const getTeam = vi.fn();
const deleteTeam = vi.fn();
let currentUser: Record<string, unknown> = {};

vi.mock("../../api/workspace", () => ({
  getTeam: (s: string) => getTeam(s),
  deleteTeam: (id: number) => deleteTeam(id),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: currentUser }),
}));

import TeamPage from "../../teams/TeamPage";

const OWNER = {
  id: 1,
  scope: "organization",
  effective_role: "owner",
  mode: "admin",
  can_switch_admin: true,
  permissions: ["members:manage"],
};

const REAL_TEAM = {
  id: 42,
  name: "Engineering",
  slug: "engineering",
  tagline: null,
  description: null,
};

function renderAt(slug: string) {
  render(
    <MemoryRouter initialEntries={[`/teams/${slug}`]}>
      <Routes>
        <Route path="/teams/:slug" element={<TeamPage />} />
        <Route path="/home" element={<p>home page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("team page: delete team", () => {
  beforeEach(() => {
    getTeam.mockReset();
    deleteTeam.mockReset();
    currentUser = OWNER;
  });
  afterEach(() => vi.restoreAllMocks());

  it("lets an owner delete a real team after confirming, then leaves", async () => {
    getTeam.mockResolvedValue(REAL_TEAM);
    deleteTeam.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: /delete team/i })
    );

    expect(deleteTeam).toHaveBeenCalledWith(42);
    expect(await screen.findByText("home page")).toBeTruthy();
  });

  it("does nothing when the owner cancels the confirmation", async () => {
    getTeam.mockResolvedValue(REAL_TEAM);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: /delete team/i })
    );

    expect(deleteTeam).not.toHaveBeenCalled();
  });

  it("shows the error and stays when the delete fails", async () => {
    getTeam.mockResolvedValue(REAL_TEAM);
    deleteTeam.mockRejectedValue(new Error("Team not found"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: /delete team/i })
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Team not found"
    );
    expect(screen.queryByText("home page")).toBeNull();
  });

  it("is hidden from non-owners", async () => {
    currentUser = { ...OWNER, effective_role: "admin" };
    getTeam.mockResolvedValue(REAL_TEAM);
    renderAt("engineering");

    await screen.findByText(/members/i);
    expect(screen.queryByRole("button", { name: /delete team/i })).toBeNull();
  });

  it("is hidden from an owner in normal (non-admin) mode", async () => {
    currentUser = { ...OWNER, mode: "normal" };
    getTeam.mockResolvedValue(REAL_TEAM);
    renderAt("engineering");

    await screen.findByText(/members/i);
    expect(screen.queryByRole("button", { name: /delete team/i })).toBeNull();
  });

  it("is never offered for a display-only sample team", async () => {
    getTeam.mockRejectedValue(new Error("Team not found"));
    renderAt("finance");

    await screen.findByText("Guadalupe Herrera");
    expect(screen.queryByRole("button", { name: /delete team/i })).toBeNull();
  });
});
