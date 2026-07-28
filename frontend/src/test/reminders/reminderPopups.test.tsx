// Verifies the reminder popup: it pops for a reminder within ~1 minute of its
// remind time, stays hidden for one further out, and snoozes on demand.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Local ISO-ish string (no zone) for `offsetSec` seconds from now.
function at(offsetSec: number) {
  const d = new Date(Date.now() + offsetSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Local "YYYY-MM-DD" / "HH:MM:SS" pair for `offsetSec` seconds from now — the
// naive wall-clock shape the meetings API returns.
function meetingAt(offsetSec: number) {
  const [date, time] = at(offsetSec).split("T");
  return { date, start_time: time, end_time: time };
}

const getReminders = vi.fn();
const getMeetings = vi.fn();
const showDesktopNotification = vi.fn();
vi.mock("../../api/reminders", () => ({ getReminders: () => getReminders() }));
vi.mock("../../api/scheduler", () => ({ getMeetings: () => getMeetings() }));
vi.mock("../../components/desktopNotifications", () => ({
  showDesktopNotification: (...args: unknown[]) =>
    showDesktopNotification(...args),
}));

// Mutable so individual cases can vary the meeting-alert lead time.
let mockUser: Record<string, unknown> = { id: 1, email: "me@test.local" };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => ({ user: mockUser }) }));

import ReminderPopups from "../../components/ReminderPopups";

describe("ReminderPopups", () => {
  beforeEach(() => {
    getReminders.mockReset();
    getReminders.mockResolvedValue([]);
    getMeetings.mockReset();
    getMeetings.mockResolvedValue([]);
    showDesktopNotification.mockReset();
    showDesktopNotification.mockReturnValue(true);
    mockUser = { id: 1, email: "me@test.local", meeting_alert_minutes: 10 };
    sessionStorage.clear();
  });

  it("pops a reminder due within a minute", async () => {
    getReminders.mockResolvedValue([
      { id: 1, title: "Call the dentist", notes: null, remind_at: at(30) },
    ]);
    render(<ReminderPopups />);
    expect(await screen.findByText("Call the dentist")).toBeTruthy();
  });

  it("stays hidden for a reminder more than a minute out", async () => {
    getReminders.mockResolvedValue([
      { id: 2, title: "Later thing", notes: null, remind_at: at(600) },
    ]);
    render(<ReminderPopups />);
    await waitFor(() => expect(getReminders).toHaveBeenCalled());
    expect(screen.queryByText("Later thing")).toBeNull();
  });

  it("snoozes on demand", async () => {
    getReminders.mockResolvedValue([
      { id: 3, title: "Standup soon", notes: null, remind_at: at(20) },
    ]);
    render(<ReminderPopups />);
    await screen.findByText("Standup soon");

    fireEvent.click(screen.getByRole("button", { name: /snooze/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "5 min" }));

    await waitFor(() => expect(screen.queryByText("Standup soon")).toBeNull());
    expect(sessionStorage.getItem("rwayve.reminderPopups.snoozed")).toContain(
      "3"
    );
  });

  it("pops a meeting inside the user's lead time", async () => {
    // 5 minutes out, with a 10-minute lead.
    getMeetings.mockResolvedValue([
      { id: 1, title: "Design review", ...meetingAt(300) },
    ]);
    render(<ReminderPopups />);
    expect(await screen.findByText("Design review")).toBeTruthy();
  });

  it("stays hidden for a meeting beyond the lead time", async () => {
    // 30 minutes out, with a 10-minute lead.
    getMeetings.mockResolvedValue([
      { id: 2, title: "Far off sync", ...meetingAt(1800) },
    ]);
    render(<ReminderPopups />);
    await waitFor(() => expect(getMeetings).toHaveBeenCalled());
    expect(screen.queryByText("Far off sync")).toBeNull();
  });

  it("honours a longer lead time", async () => {
    // Same 30-minutes-out meeting now falls inside a 30-minute lead.
    mockUser = { ...mockUser, meeting_alert_minutes: 30 };
    getMeetings.mockResolvedValue([
      { id: 3, title: "Far off sync", ...meetingAt(1740) },
    ]);
    render(<ReminderPopups />);
    expect(await screen.findByText("Far off sync")).toBeTruthy();
  });

  it("skips the meetings fetch entirely when alerts are off", async () => {
    mockUser = { ...mockUser, meeting_alert_minutes: 0 };
    getMeetings.mockResolvedValue([
      { id: 4, title: "Should not show", ...meetingAt(60) },
    ]);
    render(<ReminderPopups />);
    await waitFor(() => expect(getReminders).toHaveBeenCalled());
    expect(getMeetings).not.toHaveBeenCalled();
    expect(screen.queryByText("Should not show")).toBeNull();
  });

  it("offers a Join link when the meeting has a join url", async () => {
    getMeetings.mockResolvedValue([
      {
        id: 5,
        title: "Zoom standup",
        ...meetingAt(120),
        zoom_join_url: "https://zoom.example/j/42",
      },
    ]);
    render(<ReminderPopups />);
    await screen.findByText("Zoom standup");
    const join = screen.getByRole("link", { name: "Join" });
    expect(join.getAttribute("href")).toBe("https://zoom.example/j/42");
  });

  it("raises one desktop notification per due item", async () => {
    getMeetings.mockResolvedValue([
      { id: 8, title: "Roadmap sync", ...meetingAt(120) },
    ]);
    render(<ReminderPopups />);
    await screen.findByText("Roadmap sync");

    await waitFor(() =>
      expect(showDesktopNotification).toHaveBeenCalledTimes(1)
    );
    const [title, body, tag] = showDesktopNotification.mock.calls[0];
    expect(title).toMatch(/^Meeting in \d+ mins?$/);
    expect(body).toContain("Roadmap sync");
    expect(tag).toBe("meeting:8");
    expect(sessionStorage.getItem("rwayve.reminderPopups.notified")).toContain(
      "meeting:8"
    );
  });

  it("does not mark an item notified when no toast was raised", async () => {
    // Permission denied / desktop notifications off. Recording these as
    // notified would permanently skip an item that's still on screen when the
    // user grants permission, so the popup must leave the ledger untouched.
    showDesktopNotification.mockReturnValue(false);
    getMeetings.mockResolvedValue([
      { id: 9, title: "Silent meeting", ...meetingAt(120) },
    ]);
    render(<ReminderPopups />);
    await screen.findByText("Silent meeting");

    await waitFor(() => expect(showDesktopNotification).toHaveBeenCalled());
    expect(
      sessionStorage.getItem("rwayve.reminderPopups.notified")
    ).not.toContain("meeting:9");
  });

  it("keeps a reminder and a meeting sharing an id independent", async () => {
    // Separate tables, separate id sequences: dismissing one must not dismiss
    // the other, which is why persisted keys are namespaced by kind.
    getReminders.mockResolvedValue([
      { id: 7, title: "Reminder seven", notes: null, remind_at: at(30) },
    ]);
    getMeetings.mockResolvedValue([
      { id: 7, title: "Meeting seven", ...meetingAt(120) },
    ]);
    render(<ReminderPopups />);
    await screen.findByText("Reminder seven");
    await screen.findByText("Meeting seven");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder" }));

    await waitFor(() =>
      expect(screen.queryByText("Reminder seven")).toBeNull()
    );
    expect(screen.queryByText("Meeting seven")).toBeTruthy();
  });
});
