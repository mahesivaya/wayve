// The create/edit form opens inside the board rather than over the whole window.
// Mounts the real Tasks component (the same component behind the Tickets and User
// Stories boards) with a mocked API.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: "June task",
      description: "Ship it",
      priority: 3,
      status: "todo",
      created_at: "2026-06-01T12:00:00Z",
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

const expectContained = (title: string) => {
  const dialog = screen
    .getByRole("heading", { name: title })
    .closest<HTMLElement>('[role="dialog"]');
  expect(dialog?.className).toContain("modal-overlay--contained");
  expect(dialog?.closest(".tasks-app")).not.toBeNull();
  expect(document.body.style.overflow).not.toBe("hidden");
  return dialog as HTMLElement;
};

describe("Tasks form", () => {
  it("opens the create form inside the board", async () => {
    renderTasks();
    await screen.findByText("June task");
    fireEvent.click(screen.getAllByText("+ Create task")[0]);
    expect(
      within(expectContained("Create Task")).getByLabelText("Task title")
    ).toBeTruthy();
  });

  it("opens the edit form inside the board", async () => {
    renderTasks();
    await screen.findByText("June task");
    fireEvent.click(screen.getByRole("button", { name: "Edit June task" }));
    await screen.findByRole("button", { name: "Save changes" });
    expectContained("Edit Task");
  });
});
