// Verifies the "date created" filter on the Tasks page: created-after,
// created-before, and between a range. Mounts the real Tasks component with a
// mocked API returning three tasks on distinct dates.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: "June task",
      description: "",
      priority: 3,
      status: "todo",
      created_at: "2026-06-01T12:00:00Z",
    },
    {
      id: 2,
      name: "July task",
      description: "",
      priority: 3,
      status: "todo",
      created_at: "2026-07-01T12:00:00Z",
    },
    {
      id: 3,
      name: "August task",
      description: "",
      priority: 3,
      status: "todo",
      created_at: "2026-08-01T12:00:00Z",
    },
  ]),
  getProjects: vi.fn().mockResolvedValue([]),
  getAssignableUsers: vi.fn().mockResolvedValue([]),
  listTaskAttachments: vi.fn().mockResolvedValue([]),
  suggestAssignee: vi.fn().mockResolvedValue(null),
  createTaskApi: vi.fn(),
  updateTaskApi: vi.fn(),
  deleteTaskApi: vi.fn(),
  uploadTaskAttachments: vi.fn(),
  deleteTaskAttachment: vi.fn(),
  downloadTaskAttachment: vi.fn(),
}));

// The status filter renders one checkbox per configured status, so the board
// needs at least one to filter by. Unmocked this resolves to nothing and the
// status menu is empty. Only the fetch is stubbed — Tasks also pulls the
// category helpers from this module and needs the real ones.
vi.mock("../../api/taskStatuses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/taskStatuses")>()),
  getTaskStatuses: vi
    .fn()
    .mockResolvedValue([
      { id: 1, slug: "todo", name: "To Do", color: "#888", category: "open" },
    ]),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@test.local", scope: "personal" },
  }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import Tasks from "../../tasks/Tasks";

const renderTasks = () =>
  render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>
  );

// Filters now live in a popover behind the "Filters" button — open it before
// touching any control.
const openFilters = () =>
  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

const setMode = (v: string) =>
  fireEvent.change(screen.getByLabelText("Filter by date created"), {
    target: { value: v },
  });

// Status is a multi-select: a dropdown button inside the popover that reveals a
// checkbox per status. Its trigger is labelled by the current selection, which
// reads "All statuses" while nothing is picked.
const pickStatus = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: /All statuses/ }));
  fireEvent.click(await screen.findByLabelText(name));
};

describe("Tasks date-created filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows all tasks by default", async () => {
    renderTasks();
    expect(await screen.findByText("June task")).toBeTruthy();
    expect(screen.getByText("July task")).toBeTruthy();
    expect(screen.getByText("August task")).toBeTruthy();
  });

  it("filters to tasks created after a date", async () => {
    renderTasks();
    await screen.findByText("June task");
    openFilters();
    setMode("after");
    fireEvent.change(screen.getByLabelText("Created on or after"), {
      target: { value: "2026-07-01" },
    });
    await waitFor(() => expect(screen.queryByText("June task")).toBeNull());
    expect(screen.getByText("July task")).toBeTruthy();
    expect(screen.getByText("August task")).toBeTruthy();
  });

  it("filters to tasks created before a date", async () => {
    renderTasks();
    await screen.findByText("June task");
    openFilters();
    setMode("before");
    fireEvent.change(screen.getByLabelText("Created on or before"), {
      target: { value: "2026-07-01" },
    });
    await waitFor(() => expect(screen.queryByText("August task")).toBeNull());
    expect(screen.getByText("June task")).toBeTruthy();
    expect(screen.getByText("July task")).toBeTruthy();
  });

  it("filters to tasks created between two dates", async () => {
    renderTasks();
    await screen.findByText("June task");
    openFilters();
    setMode("between");
    fireEvent.change(screen.getByLabelText("From date"), {
      target: { value: "2026-06-15" },
    });
    fireEvent.change(screen.getByLabelText("To date"), {
      target: { value: "2026-07-15" },
    });
    await waitFor(() => expect(screen.queryByText("June task")).toBeNull());
    expect(screen.queryByText("August task")).toBeNull();
    expect(screen.getByText("July task")).toBeTruthy();
  });

  it("badges the active filter count and clears all", async () => {
    renderTasks();
    await screen.findByText("June task");
    openFilters();
    // Apply status + date → two active filters.
    await pickStatus("To Do");
    setMode("after");
    fireEvent.change(screen.getByLabelText("Created on or after"), {
      target: { value: "2026-07-01" },
    });
    // Button shows a "2" badge (query by the button's accessible name).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Filters/ }).textContent
      ).toContain("2")
    );
    // Clear all resets everything and restores all tasks.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.getByText("June task")).toBeTruthy());
    expect(screen.getByText("August task")).toBeTruthy();
  });
});
