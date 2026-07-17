// Verifies the app-wide meeting reminder: a small card pops for a meeting
// within 15 minutes of starting, stays hidden for one further out, and goes
// away when dismissed. Meeting times are built relative to the real clock so
// the timing predicate is exercised without faking timers.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Local YYYY-MM-DD + HH:MM for `offsetMin` minutes from now.
function at(offsetMin: number) {
  const d = new Date(Date.now() + offsetMin * 60_000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  return { date, start_time: time };
}

const getMeetings = vi.fn();
vi.mock("../../api/scheduler", () => ({
  getMeetings: () => getMeetings(),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@test.local" } }),
}));

import MeetingReminders from "../../components/MeetingReminders";

const renderReminders = () =>
  render(
    <MemoryRouter>
      <MeetingReminders />
    </MemoryRouter>
  );

describe("MeetingReminders", () => {
  beforeEach(() => {
    getMeetings.mockReset();
    sessionStorage.clear();
  });

  it("shows a reminder for a meeting starting within 15 minutes", async () => {
    getMeetings.mockResolvedValue([
      { id: 1, title: "Standup", ...at(10), zoom_join_url: null },
    ]);
    renderReminders();
    expect(await screen.findByText("Standup")).toBeTruthy();
  });

  it("does not remind for a meeting more than 15 minutes out", async () => {
    getMeetings.mockResolvedValue([
      { id: 2, title: "Later sync", ...at(45), zoom_join_url: null },
    ]);
    renderReminders();
    // Give the async fetch time to resolve, then assert it never appears.
    await waitFor(() => expect(getMeetings).toHaveBeenCalled());
    expect(screen.queryByText("Later sync")).toBeNull();
  });

  it("hides the reminder after it is dismissed", async () => {
    getMeetings.mockResolvedValue([
      { id: 3, title: "Retro", ...at(5), zoom_join_url: null },
    ]);
    renderReminders();
    await screen.findByText("Retro");
    fireEvent.click(screen.getByRole("button", { name: /dismiss reminder/i }));
    await waitFor(() => expect(screen.queryByText("Retro")).toBeNull());
  });

  it("snoozes the reminder for the chosen interval", async () => {
    getMeetings.mockResolvedValue([
      { id: 4, title: "Planning", ...at(12), zoom_join_url: null },
    ]);
    renderReminders();
    await screen.findByText("Planning");

    // Open the snooze menu, then pick 10 min.
    fireEvent.click(screen.getByRole("button", { name: /snooze/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "10 min" }));

    await waitFor(() => expect(screen.queryByText("Planning")).toBeNull());
    // The snooze window is persisted so it survives a route change / re-mount.
    expect(sessionStorage.getItem("rwayve.meetingReminders.snoozed")).toContain(
      "4:"
    );
  });
});
