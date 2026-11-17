// Rows don't carry a Delete button: deleting happens from the item's edit form
// (Tasks) or its detail page (stories, tickets).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const remove = vi.fn().mockResolvedValue(undefined);

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 1,
      task_number: 7,
      name: "Fix the login redirect",
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
  deleteTaskApi: (id: number) => remove(id),
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

describe("row delete", () => {
  beforeEach(() => {
    window.localStorage.clear();
    remove.mockClear();
  });

  it("keeps Delete out of the rows and deletes from the edit form", async () => {
    render(
      <MemoryRouter>
        <Tasks />
      </MemoryRouter>
    );
    await screen.findByText("Fix the login redirect");
    const table = document.querySelector(".task-table") as HTMLElement;
    expect(within(table).queryByRole("button", { name: /delete/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Fix the login redirect" })
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(window.confirm).toHaveBeenCalledWith(
      'Delete task "Fix the login redirect"? This cannot be undone.'
    );
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(1));
  });
});
