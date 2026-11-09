// A team's roster is saved: members come back with the team, adding and removing
// go through the API, and the Delete button is only for member managers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const getTeam = vi.fn();
const addTeamMember = vi.fn();
const removeTeamMember = vi.fn();
const updateTeamDescription = vi.fn();
let currentUser: Record<string, unknown> = {};

vi.mock("../../api/workspace", () => ({
  getTeam: (s: string) => getTeam(s),
  deleteTeam: vi.fn(),
  updateTeamDescription: (id: number, d: string) =>
    updateTeamDescription(id, d),
  addTeamMember: (id: number, input: unknown) => addTeamMember(id, input),
  removeTeamMember: (id: number, memberId: number) =>
    removeTeamMember(id, memberId),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: currentUser }),
}));

vi.mock("../../documents/DocumentsBox", () => ({
  default: ({ teamId }: { teamId?: number }) => (
    <div>files of team {teamId}</div>
  ),
}));

import TeamPage from "../../teams/TeamPage";

const MANAGER = {
  id: 1,
  scope: "organization",
  effective_role: "admin",
  mode: "admin",
  can_switch_admin: true,
  permissions: ["members:manage", "org:settings"],
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

function renderAt(slug: string, query = "?tab=members") {
  render(
    <MemoryRouter initialEntries={[`/teams/${slug}${query}`]}>
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
    updateTeamDescription.mockReset();
    currentUser = MANAGER;
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the team's name at the top of the page", async () => {
    getTeam.mockResolvedValue(TEAM);
    renderAt("engineering");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Engineering" })
    ).toBeTruthy();
  });

  it("opens on Overview, and the buttons switch sections", async () => {
    getTeam.mockResolvedValue({ ...TEAM, description: "We build things." });
    renderAt("engineering", "");

    const button = (name: string) => screen.findByRole("button", { name });
    expect((await button("Overview")).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(screen.getByDisplayValue("We build things.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ada Lovelace" })).toBeNull();

    await userEvent.click(await button("Documents"));
    expect(screen.getByText("files of team 42")).toBeTruthy();
    expect(screen.queryByDisplayValue("We build things.")).toBeNull();

    await userEvent.click(await button("Members"));
    expect(await button("Ada Lovelace")).toBeTruthy();
    expect((await button("Members")).getAttribute("aria-current")).toBe("page");
  });

  it("gives the security role, which can edit the roster, no textbox", async () => {
    currentUser = {
      ...MANAGER,
      effective_role: "security",
      permissions: ["members:manage"],
    };
    getTeam.mockResolvedValue({ ...TEAM, description: "Read only" });
    renderAt("engineering", "");

    expect(await screen.findByText("Read only")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Team description" })
    ).toBeNull();
  });

  it("shows viewers the description as text, with no textbox", async () => {
    currentUser = { ...MANAGER, permissions: [] };
    getTeam.mockResolvedValue(TEAM);
    renderAt("engineering", "");
    expect(await screen.findByText("No description yet.")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Team description" })
    ).toBeNull();
  });

  it("saves the description when the textbox loses focus", async () => {
    getTeam.mockResolvedValue(TEAM);
    updateTeamDescription.mockResolvedValue({
      ...TEAM,
      description: "New text",
    });
    renderAt("engineering", "");

    const box = await screen.findByRole("textbox", {
      name: "Team description",
    });
    await userEvent.type(box, "  New text ");
    await userEvent.tab();

    expect(updateTeamDescription).toHaveBeenCalledWith(42, "New text");
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("does not save when nothing changed", async () => {
    getTeam.mockResolvedValue({ ...TEAM, description: "Same" });
    renderAt("engineering", "");

    await userEvent.click(
      await screen.findByRole("textbox", { name: "Team description" })
    );
    await userEvent.tab();

    expect(updateTeamDescription).not.toHaveBeenCalled();
  });

  it("keeps the typed text and shows the error when saving fails", async () => {
    getTeam.mockResolvedValue(TEAM);
    updateTeamDescription.mockRejectedValue(new Error("Nope"));
    renderAt("engineering", "");

    const box = await screen.findByRole("textbox", {
      name: "Team description",
    });
    await userEvent.type(box, "Draft");
    await userEvent.tab();

    expect((await screen.findByRole("alert")).textContent).toBe("Nope");
    expect((box as HTMLTextAreaElement).value).toBe("Draft");
  });

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

  // No team is ever invented for a name the org doesn't have.
  it("reports a slug with no team as not found", async () => {
    getTeam.mockRejectedValue(new Error("Team not found"));
    renderAt("finance");

    expect(await screen.findByText("Team not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add member/i })).toBeNull();
  });
});
