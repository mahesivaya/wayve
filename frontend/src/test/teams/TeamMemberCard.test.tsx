// Clicking a name in the team roster opens that member's details beside the
// list; the card closes on ✕, Escape, a second click, or removing the member.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const getTeam = vi.fn();
const removeTeamMember = vi.fn();

vi.mock("../../api/workspace", () => ({
  getTeam: (s: string) => getTeam(s),
  deleteTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: (id: number, memberId: number) =>
    removeTeamMember(id, memberId),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      scope: "organization",
      effective_role: "admin",
      mode: "admin",
      can_switch_admin: true,
      permissions: ["members:manage"],
    },
  }),
}));

import TeamPage from "../../teams/TeamPage";

const TEAM = {
  id: 42,
  name: "Engineering",
  slug: "engineering",
  tagline: null,
  description: null,
  members: [
    {
      id: 7,
      name: "Ada Lovelace",
      role: "Engineer",
      email: "ada@x.test",
      teams: ["Engineering", "Research"],
    },
    { id: 8, name: "Alan Turing", role: null, email: null },
  ],
};

async function openPage() {
  render(
    <MemoryRouter initialEntries={["/teams/engineering?tab=members"]}>
      <Routes>
        <Route path="/teams/:slug" element={<TeamPage />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole("button", { name: "Ada Lovelace" });
}

const clickName = (name: string) =>
  userEvent.click(screen.getByRole("button", { name }));
const card = (name: string) =>
  screen.getByRole("complementary", { name: `Details for ${name}` });
const anyCard = () => screen.queryByRole("complementary");

describe("team member details card", () => {
  beforeEach(() => {
    getTeam.mockReset();
    getTeam.mockResolvedValue(TEAM);
    removeTeamMember.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("is closed until a name is clicked, then shows that member", async () => {
    await openPage();
    expect(anyCard()).toBeNull();

    await clickName("Ada Lovelace");

    const details = within(card("Ada Lovelace"));
    expect(details.getByText("ada@x.test")).toBeTruthy();
    expect(details.getByText("Engineer")).toBeTruthy();
    expect(details.getByText("Engineering, Research")).toBeTruthy();
  });

  it("keeps the email out of the list and shows it once, as plain text, in the card", async () => {
    await openPage();
    expect(screen.queryByText("ada@x.test")).toBeNull();

    await clickName("Ada Lovelace");

    expect(screen.getAllByText("ada@x.test")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "ada@x.test" })).toBeNull();
  });

  it("switches to another member, with dashes for details they lack", async () => {
    await openPage();
    await clickName("Ada Lovelace");
    await clickName("Alan Turing");

    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    const details = within(card("Alan Turing"));
    expect(details.getByText("Member")).toBeTruthy();
    expect(details.getAllByText("—")).toHaveLength(2);
  });

  it("closes on the ✕ button", async () => {
    await openPage();
    await clickName("Ada Lovelace");
    await userEvent.click(
      screen.getByRole("button", { name: "Close details" })
    );
    expect(anyCard()).toBeNull();
  });

  it("closes on Escape", async () => {
    await openPage();
    await clickName("Ada Lovelace");
    await userEvent.keyboard("{Escape}");
    expect(anyCard()).toBeNull();
  });

  it("closes when the same name is clicked again", async () => {
    await openPage();
    await clickName("Ada Lovelace");
    await clickName("Ada Lovelace");
    expect(anyCard()).toBeNull();
  });

  it("closes when the open member is removed from the team", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    removeTeamMember.mockResolvedValue(undefined);
    await openPage();
    await clickName("Ada Lovelace");

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Ada Lovelace" })
    );

    await screen.findByRole("button", { name: "Alan Turing" });
    expect(screen.queryByRole("button", { name: "Ada Lovelace" })).toBeNull();
    expect(anyCard()).toBeNull();
  });
});
