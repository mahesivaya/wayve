// Verifies the Reminders page: upcoming meetings render soonest-first, past
// meetings are excluded, and open tasks order by priority (Highest first) while
// done tasks are dropped. Data comes from mocked meeting + task APIs.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// YYYY-MM-DD + HH:MM for `offsetMin` minutes from now.
function at(offsetMin: number) {
  const d = new Date(Date.now() + offsetMin * 60_000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  return { date, start_time: time, end_time: time };
}

const getMeetings = vi.fn();
const getTasks = vi.fn();
const getReminders = vi.fn();
const createReminder = vi.fn();
const deleteReminder = vi.fn();

vi.mock("../../api/scheduler", () => ({ getMeetings: () => getMeetings() }));
vi.mock("../../api/tasks", () => ({ getTasks: () => getTasks() }));
vi.mock("../../api/reminders", () => ({
  getReminders: () => getReminders(),
  createReminder: (d: unknown) => createReminder(d),
  deleteReminder: (id: number) => deleteReminder(id),
}));

import Reminders from "../../reminders/Reminders";

const renderPage = () =>
  render(
    <MemoryRouter>
      <Reminders />
    </MemoryRouter>
  );

describe("Reminders page", () => {
  beforeEach(() => {
    getMeetings.mockReset();
    getTasks.mockReset();
    getReminders.mockReset();
    createReminder.mockReset();
    deleteReminder.mockReset();
    getTasks.mockResolvedValue([]);
    getMeetings.mockResolvedValue([]);
    getReminders.mockResolvedValue([]);
    createReminder.mockResolvedValue({});
    deleteReminder.mockResolvedValue({});
  });

  it("lists upcoming meetings soonest-first and drops past ones", async () => {
    getMeetings.mockResolvedValue([
      { id: 1, title: "Later sync", ...at(180) },
      { id: 2, title: "Soon standup", ...at(20) },
      { id: 3, title: "Old meeting", ...at(-120) },
    ]);
    renderPage();

    await screen.findByText("Soon standup");
    expect(screen.queryByText("Old meeting")).toBeNull();

    const titles = screen
      .getAllByText(/Soon standup|Later sync/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Soon standup", "Later sync"]);
  });

  it("orders open tasks by priority and hides done tasks", async () => {
    getTasks.mockResolvedValue([
      // P1 is the highest priority and P5 the lowest, so "Urgent task" must
      // sort above "Low task" even though its number is smaller.
      {
        id: 1,
        name: "Low task",
        priority: 4,
        status: "to_do",
        created_at: null,
      },
      {
        id: 2,
        name: "Urgent task",
        priority: 1,
        status: "in_progress",
        created_at: null,
      },
      {
        id: 3,
        name: "Finished task",
        priority: 2,
        status: "done",
        created_at: null,
      },
    ]);
    renderPage();

    await screen.findByText("Urgent task");
    expect(screen.queryByText("Finished task")).toBeNull();

    const titles = screen
      .getAllByText(/Urgent task|Low task/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Urgent task", "Low task"]);
  });

  it("shows empty states when there is nothing", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No upcoming meetings.")).toBeTruthy()
    );
    expect(screen.getByText("No open tasks.")).toBeTruthy();
  });

  it("renders the create form and submits a reminder", async () => {
    const { fireEvent } = await import("@testing-library/react");
    renderPage();
    await screen.findByText("New reminder");

    fireEvent.change(screen.getByLabelText("Reminder title"), {
      target: { value: "Call the dentist" },
    });
    fireEvent.change(screen.getByLabelText("Remind at"), {
      target: { value: "2026-07-18T14:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add reminder/i }));

    await waitFor(() => expect(createReminder).toHaveBeenCalledTimes(1));
    expect(createReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Call the dentist",
        remind_at: "2026-07-18T14:30",
      })
    );
  });

  it("lists created reminders soonest-first", async () => {
    getReminders.mockResolvedValue([
      {
        id: 1,
        title: "Later reminder",
        notes: null,
        remind_at: "2026-07-20T09:00:00",
      },
      {
        id: 2,
        title: "Sooner reminder",
        notes: null,
        remind_at: "2026-07-18T09:00:00",
      },
    ]);
    renderPage();
    await screen.findByText("Sooner reminder");

    const titles = screen
      .getAllByText(/Sooner reminder|Later reminder/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Sooner reminder", "Later reminder"]);
  });
});
