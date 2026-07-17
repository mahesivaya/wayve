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

const getReminders = vi.fn();
vi.mock("../../api/reminders", () => ({ getReminders: () => getReminders() }));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@test.local" } }),
}));

import ReminderPopups from "../../components/ReminderPopups";

describe("ReminderPopups", () => {
  beforeEach(() => {
    getReminders.mockReset();
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
    expect(
      sessionStorage.getItem("rwayve.reminderPopups.snoozed")
    ).toContain("3");
  });
});
