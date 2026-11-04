// The team member list: searching, filtering and sorting only change what's
// shown, and Delete always acts on the member in that row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TeamMembersTable, { type Member } from "../../teams/TeamMembersTable";

const thisYear = new Date().getFullYear();
const MEMBERS: Member[] = [
  {
    id: 1,
    name: "Grace Hopper",
    role: "Admin",
    email: "grace@x.test",
    joinedAt: new Date(thisYear, 5, 6, 12).toISOString(),
    teams: ["Engineering", "Leadership"],
  },
  {
    id: 2,
    name: "Ada Lovelace",
    role: "Engineer",
    email: "ada@x.test",
    joinedAt: new Date(2019, 0, 15, 12).toISOString(),
    teams: ["Engineering"],
  },
  {
    id: 3,
    name: "Alan Turing",
    role: "Engineer",
    email: "",
    joinedAt: null,
    teams: [],
  },
];

const renderTable = (canManage = true) => {
  const onRemove = vi.fn();
  render(
    <TeamMembersTable
      members={MEMBERS}
      canManage={canManage}
      busy={false}
      onRemove={onRemove}
    />
  );
  return onRemove;
};

// Row 0 is the column headings.
const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);

const openMenu = (name: string) =>
  userEvent.click(screen.getByRole("button", { name }));

afterEach(cleanup);

describe("the team member list", () => {
  it("lists members by name, and reverses when the heading is clicked", async () => {
    renderTable();
    expect(names()[0]).toContain("Ada Lovelace");
    expect(names()[2]).toContain("Grace Hopper");

    await userEvent.click(screen.getByRole("button", { name: /^name/i }));

    expect(names()[0]).toContain("Grace Hopper");
    expect(
      screen
        .getByRole("columnheader", { name: /name/i })
        .getAttribute("aria-sort")
    ).toBe("descending");
  });

  it("finds members by name, email or role", async () => {
    renderTable();
    const search = screen.getByRole("searchbox", { name: "Find members" });

    await userEvent.type(search, "grace@");
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Grace Hopper");

    await userEvent.clear(search);
    await userEvent.type(search, "admin");
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Grace Hopper");

    await userEvent.clear(search);
    await userEvent.type(search, "nobody");
    expect(screen.getByText("No members match.")).toBeTruthy();
  });

  it("filters by role, and can go back to all roles", async () => {
    renderTable();
    await openMenu("Filter by role");

    await userEvent.click(screen.getByRole("menuitemradio", { name: "Admin" }));
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Grace Hopper");

    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "All roles" })
    );
    expect(names()).toHaveLength(3);
  });

  it("shows when each member joined, with the year only when it differs", () => {
    renderTable();
    const cells = (name: string) =>
      within(screen.getByRole("row", { name: new RegExp(name) })).getAllByRole(
        "cell"
      );

    expect(cells("Grace Hopper")[2].textContent).not.toContain(
      String(thisYear)
    );
    expect(cells("Ada Lovelace")[2].textContent).toContain("2019");
    expect(cells("Alan Turing")[2].textContent).toBe("");
  });

  it("lists the teams each member is on, and finds members by team", async () => {
    renderTable();
    const row = screen.getByRole("row", { name: /Grace Hopper/ });
    expect(within(row).getAllByRole("cell")[3].textContent).toBe(
      "Engineering, Leadership"
    );

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Find members" }),
      "leadership"
    );
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Grace Hopper");
  });

  it("hides and restores columns from the display options", async () => {
    renderTable();
    await openMenu("Display options");

    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Joined" })
    );
    expect(screen.queryByRole("columnheader", { name: "Joined" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeTruthy();

    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Joined" })
    );
    expect(screen.getByRole("columnheader", { name: "Joined" })).toBeTruthy();
  });

  it("deletes the member in that row, even after sorting and filtering", async () => {
    const onRemove = renderTable();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Find members" }),
      "engineer"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Alan Turing" })
    );

    expect(onRemove).toHaveBeenCalledWith(MEMBERS[2]);
  });

  it("offers no delete button to users who can't manage members", () => {
    renderTable(false);
    expect(screen.queryByRole("button", { name: /^delete /i })).toBeNull();
  });
});
