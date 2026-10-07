// A real team's roster is saved: members come back with the team, adding and
// removing go through the API, and the Delete button is only for member managers. A sample
// team (no backend row) keeps edits in the browser, as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const getTeam = vi.fn();
const addTeamMember = vi.fn();
const removeTeamMember = vi.fn();
let currentUser: Record<string, unknown> = {};

vi.mock("../../api/workspace", () => ({
  getTeam: (s: string) => getTeam(s),
  deleteTeam: vi.fn(),
  addTeamMember: (id: number, input: unknown) => addTeamMember(id, input),
  removeTeamMember: (id: number, memberId: number) =>
    removeTeamMember(id, memberId),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: currentUser }),
}));

import TeamPage from "../../teams/TeamPage";

const MANAGER = {
  id: 1,
  scope: "organization",
  effective_role: "admin",
  mode: "admin",
  can_switch_admin: true,
  permissions: ["members:manage"],
};

const TEAM = {
  id: 42,
  name: "Engineering",
  slug: "engineering",
  tagline: null,
  description: null,
  members: [
    { id: 7, name: "Ada Lovelace", role: "Engineer", email: "ada@x.test" },
    { id: 8, name: "Alan Turing", role: null, email: null },
  ],
};

function renderAt(slug: string) {
  render(
    <MemoryRouter initialEntries={[`/teams/${slug}`]}>
      <Routes>
        <Route path="/teams/:slug" element={<TeamPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("team page: saved roster", () => {
  beforeEach(() => {
    getTeam.mockReset();
    addTeamMember.mockReset();
    removeTeamMember.mockReset();
    currentUser = MANAGER;
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the members saved with the team", async () => {
    getTeam.mockResolvedValue(TEAM);
    renderAt("engineering");

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    // A saved member with no role still reads as a member.
    expect(screen.getByText("Alan Turing")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });

  it("removes a member through the API after confirming", async () => {
    getTeam.mockResolvedValue(TEAM);
    removeTeamMember.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Ada Lovelace" })
    );

    expect(removeTeamMember).toHaveBeenCalledWith(42, 7);
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.getByText("Alan Turing")).toBeTruthy();
  });

  it("keeps the member and shows the error when removal fails", async () => {
    getTeam.mockResolvedValue(TEAM);
    removeTeamMember.mockRejectedValue(new Error("Member not found"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Ada Lovelace" })
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Member not found"
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("does nothing when the removal is cancelled", async () => {
    getTeam.mockResolvedValue(TEAM);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Ada Lovelace" })
    );

    expect(removeTeamMember).not.toHaveBeenCalled();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("saves an added member through the API", async () => {
    getTeam.mockResolvedValue({ ...TEAM, members: [] });
    addTeamMember.mockResolvedValue({
      id: 9,
      name: "Grace Hopper",
      role: "Admiral",
      email: null,
    });
    renderAt("engineering");

    await userEvent.click(
      await screen.findByRole("button", { name: /add member/i })
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Member name" }),
      "Grace Hopper"
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Member role" }),
      "Admiral"
    );
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(addTeamMember).toHaveBeenCalledWith(42, {
      name: "Grace Hopper",
      role: "Admiral",
      email: "",
    });
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete Grace Hopper" })
    ).toBeTruthy();
  });

  it("hides the remove buttons from users who can't manage members", async () => {
    currentUser = { ...MANAGER, permissions: [] };
    getTeam.mockResolvedValue(TEAM);
    renderAt("engineering");

    await screen.findByText("Ada Lovelace");
    expect(screen.queryByRole("button", { name: /^delete /i })).toBeNull();
  });

  it("removes from a sample team locally, without calling the API", async () => {
    getTeam.mockRejectedValue(new Error("Team not found"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("finance");

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Guadalupe Herrera" })
    );

    expect(removeTeamMember).not.toHaveBeenCalled();
    expect(screen.queryByText("Guadalupe Herrera")).toBeNull();
  });
});
