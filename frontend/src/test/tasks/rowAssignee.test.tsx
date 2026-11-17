// The Assignee cell of a list row is a dropdown of the members who can be
// assigned, so the assignee changes from the list without opening the item.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// vi.mock factories are hoisted above the file's own declarations.
const { update, task } = vi.hoisted(() => ({
  update: vi.fn(),
  task: {
    id: 1,
    task_number: 7,
    name: "Fix the login redirect",
    description: "",
    priority: 3,
    status: "todo",
    assigned_by: "",
    assignee: "ann@test.local",
    assignee_id: 11,
    created_at: "2026-07-01T12:00:00Z",
  },
}));

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([task]),
  getProjects: vi.fn().mockResolvedValue([]),
  getAssignableUsers: vi.fn().mockResolvedValue([
    { user_id: 11, email: "ann@test.local", username: "Ann" },
    { user_id: 12, email: "bo@test.local", username: null },
  ]),
  listTaskAttachments: vi.fn().mockResolvedValue([]),
  suggestAssignee: vi.fn().mockResolvedValue(null),
  createTaskApi: vi.fn(),
  updateTaskApi: (id: number, payload: Record<string, unknown>) =>
    update(id, payload),
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
    user: { id: 1, email: "me@test.local", scope: "organization" },
  }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import Tasks from "../../tasks/Tasks";

const picker = () =>
  screen.findByLabelText(
    "Assignee of Fix the login redirect"
  ) as Promise<HTMLSelectElement>;

describe("assigning from a list row", () => {
  beforeEach(() => {
    window.localStorage.clear();
    update.mockReset();
    update.mockImplementation((_id: number, payload: object) =>
      Promise.resolve({ ...task, ...payload })
    );
  });

  it("lists every member and shows the current assignee", async () => {
    render(
      <MemoryRouter>
        <Tasks />
      </MemoryRouter>
    );
    const select = await picker();
    await waitFor(() => expect(select.value).toBe("ann@test.local"));
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Unassigned",
      "Ann",
      "bo@test.local",
    ]);
  });

  it("assigns another member, keeping the row's other fields", async () => {
    render(
      <MemoryRouter>
        <Tasks />
      </MemoryRouter>
    );
    fireEvent.change(await picker(), { target: { value: "bo@test.local" } });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        name: "Fix the login redirect",
        status: "todo",
        priority: 3,
        assignee: "bo@test.local",
        assignee_id: 12,
      })
    );
    expect((await picker()).value).toBe("bo@test.local");
  });

  it("unassigns", async () => {
    render(
      <MemoryRouter>
        <Tasks />
      </MemoryRouter>
    );
    fireEvent.change(await picker(), { target: { value: "" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ assignee: "", assignee_id: null })
      )
    );
  });
});
