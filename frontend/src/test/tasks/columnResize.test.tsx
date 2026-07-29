// List-view column resizing: dragging a header grip should widen that column
// (so a truncated ticket name can be read in full), the width should survive a
// remount, and a double-click should hand the column back to its default.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: "A ticket name long enough that the column truncates it",
      description: "",
      priority: 3,
      status: "todo",
      created_at: "2026-07-01T12:00:00Z",
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

const table = () => document.querySelector(".task-table") as HTMLElement;
const titleGrip = () =>
  screen.getByRole("separator", { name: "Resize title column" });

// jsdom gives every element a zero-width box, so the drag start width would be
// 0 and the result would be clamped to the minimum. Pin a realistic width for
// the header cell the grip belongs to.
const stubCellWidth = (px: number) => {
  const grip = titleGrip();
  const cell = grip.parentElement as HTMLElement;
  vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
    width: px,
    height: 20,
    top: 0,
    left: 0,
    right: px,
    bottom: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
};

const drag = (byPx: number) => {
  const grip = titleGrip();
  fireEvent.pointerDown(grip, { clientX: 400, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 400 + byPx, pointerId: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
};

describe("list-view column resizing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts with the title column flexible", async () => {
    renderTasks();
    await screen.findByText(/A ticket name long enough/);
    expect(table().style.getPropertyValue("--task-cols")).toContain(
      "minmax(0, 1fr)"
    );
  });

  it("widens the title column as the grip is dragged", async () => {
    renderTasks();
    await screen.findByText(/A ticket name long enough/);

    stubCellWidth(300);
    drag(160);

    await waitFor(() => {
      const cols = table().style.getPropertyValue("--task-cols");
      expect(cols).toContain("460px");
      // The flexible track is gone — this column is now explicitly sized.
      expect(cols).not.toContain("minmax(0, 1fr)");
    });
  });

  it("clamps a shrink at the minimum instead of collapsing the column", async () => {
    renderTasks();
    await screen.findByText(/A ticket name long enough/);

    stubCellWidth(100);
    drag(-500);

    await waitFor(() =>
      expect(table().style.getPropertyValue("--task-cols")).toContain("56px")
    );
  });

  it("persists the width across a remount, then resets on double-click", async () => {
    const first = renderTasks();
    await screen.findByText(/A ticket name long enough/);
    stubCellWidth(300);
    drag(100);
    await waitFor(() =>
      expect(table().style.getPropertyValue("--task-cols")).toContain("400px")
    );
    first.unmount();

    renderTasks();
    await screen.findByText(/A ticket name long enough/);
    expect(table().style.getPropertyValue("--task-cols")).toContain("400px");

    fireEvent.doubleClick(titleGrip());
    await waitFor(() =>
      expect(table().style.getPropertyValue("--task-cols")).toContain(
        "minmax(0, 1fr)"
      )
    );
  });

  it("ignores a malformed saved width rather than collapsing the column", async () => {
    window.localStorage.setItem(
      "wayve.tasks.colw",
      JSON.stringify({ title: "wide", created: -5 })
    );
    renderTasks();
    await screen.findByText(/A ticket name long enough/);
    const cols = table().style.getPropertyValue("--task-cols");
    expect(cols).toContain("minmax(0, 1fr)");
    expect(cols).toContain("124px");
  });
});
