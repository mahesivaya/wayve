// The edit form's Save button is gated on the form actually differing from the
// item it loaded, so an editor the user only looked at can't post a no-op
// update. Mounts the real Tasks component (the same component behind the
// Tickets and User Stories boards) with a mocked API.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

// Open the edit modal for the seeded task and hand back its Save button.
const openEditor = async () => {
  await screen.findByText("June task");
  fireEvent.click(screen.getByRole("button", { name: "Edit June task" }));
  return (await screen.findByRole("button", {
    name: "Save changes",
  })) as HTMLButtonElement;
};

const titleInput = () => screen.getByLabelText("Task title");

describe("Tasks edit form — Save gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens with Save disabled — nothing has changed yet", async () => {
    renderTasks();
    expect((await openEditor()).disabled).toBe(true);
  });

  it("enables Save once a field changes", async () => {
    renderTasks();
    const save = await openEditor();
    fireEvent.change(titleInput(), { target: { value: "June task, renamed" } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("re-disables Save when the edit is undone", async () => {
    renderTasks();
    const save = await openEditor();
    fireEvent.change(titleInput(), { target: { value: "June task, renamed" } });
    await waitFor(() => expect(save.disabled).toBe(false));
    // Typed back to what it was: there is nothing to save again.
    fireEvent.change(titleInput(), { target: { value: "June task" } });
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("ignores whitespace-only edits, which the save path trims away", async () => {
    renderTasks();
    const save = await openEditor();
    fireEvent.change(titleInput(), { target: { value: "June task   " } });
    // Give the re-render a chance to land before asserting nothing moved.
    await waitFor(() => expect(titleInput()).toHaveProperty("value"));
    expect(save.disabled).toBe(true);
  });

  it("leaves the create form ungated — there is no baseline to differ from", async () => {
    renderTasks();
    await screen.findByText("June task");
    fireEvent.click(screen.getByRole("button", { name: /Create task/ }));
    const create = (await screen.findByRole("button", {
      name: "Create task",
    })) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
  });
});
