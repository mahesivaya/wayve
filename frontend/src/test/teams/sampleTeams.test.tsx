// The sample teams are display-only, so the thing worth guarding is the seam:
// a slug the backend has no row for must still render a team with its roster,
// while a real backend team must never be given invented members.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const getTeam = vi.fn();

vi.mock("../../api/workspace", () => ({ getTeam: (s: string) => getTeam(s) }));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, scope: "organization", permissions: [] } }),
}));

import TeamPage from "../../teams/TeamPage";
import { SAMPLE_TEAMS, findSampleTeam } from "../../teams/sampleTeams";

function renderAt(slug: string) {
  render(
    <MemoryRouter initialEntries={[`/teams/${slug}`]}>
      <Routes>
        <Route path="/teams/:slug" element={<TeamPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("sample teams", () => {
  beforeEach(() => {
    getTeam.mockReset();
  });

  it("gives every sample team a slug-matched roster", () => {
    for (const team of SAMPLE_TEAMS) {
      expect(team.members.length).toBeGreaterThan(0);
      expect(findSampleTeam(team.slug)).toBe(team);
      // Reserved domain: nothing here can be mistaken for a real address.
      for (const m of team.members) {
        expect(m.email.endsWith("@example.com")).toBe(true);
      }
    }
  });

  it("keeps the ids negative so they cannot collide with a backend row", () => {
    const ids = SAMPLE_TEAMS.map((t) => t.id);
    expect(ids.every((id) => id < 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to the sample team, with members, when the slug has no row", async () => {
    getTeam.mockRejectedValue(new Error("Team not found"));
    renderAt("finance");

    // The page is the roster alone — no name, tagline or About section — so
    // the members are what proves the fallback resolved.
    expect(await screen.findByText("Guadalupe Herrera")).toBeTruthy();
    expect(screen.getByText("Finance Director")).toBeTruthy();
    expect(screen.getByText("Piotr Zawadzki")).toBeTruthy();
    expect(screen.queryByText("Finance")).toBeNull();
  });

  it("still reports a genuinely unknown slug as not found", async () => {
    getTeam.mockRejectedValue(new Error("Team not found"));
    renderAt("no-such-team");

    expect(await screen.findByText("Team not found")).toBeTruthy();
  });

  it("does not attach sample members to a real backend team", async () => {
    getTeam.mockResolvedValue({
      id: 12,
      name: "Engineering",
      slug: "engineering",
      tagline: null,
      description: null,
    });
    renderAt("engineering");

    // The roster renders (count 0), and none of the sample people leak into it.
    expect(await screen.findByText("Members")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("Priya Raghunathan")).toBeNull()
    );
  });
});
