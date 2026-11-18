// The User Stories list has a checkbox on every row; the header one ticks or
// clears them all, and a count with Clear shows while any row is ticked.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Hoisted with the mocks below, which build their rows from it.
const { story } = vi.hoisted(() => ({
  story: (id: number, name: string) => ({
    id,
    task_number: id,
    name,
    description: "",
    priority: 3,
    status: "todo",
    created_at: "2026-06-01T12:00:00Z",
  }),
}));

vi.mock("../../api/userStories", () => ({
  getUserStories: vi
    .fn()
    .mockResolvedValue([story(1, "Story one"), story(2, "Story two")]),
  createUserStoryApi: vi.fn(),
  updateUserStoryApi: vi.fn(),
  deleteUserStoryApi: vi.fn(),
  listStoryAttachments: vi.fn().mockResolvedValue([]),
  uploadStoryAttachments: vi.fn(),
  deleteStoryAttachment: vi.fn(),
  downloadStoryAttachment: vi.fn(),
}));

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([story(1, "Task one")]),
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
    user: { id: 1, email: "me@test.local", scope: "organization" },
  }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import UserStories from "../../userstories/UserStories";
import Tasks from "../../tasks/Tasks";

const box = (name: string) =>
  screen.getByRole<HTMLInputElement>("checkbox", { name });

describe("row checkboxes on the User Stories list", () => {
  it("ticks a single row and shows the count", async () => {
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );
    const one = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Select Story one",
    });
    expect(one.checked).toBe(false);
    expect(screen.queryByText("1 selected")).toBeNull();

    fireEvent.click(one);
    expect(one.checked).toBe(true);
    expect(box("Select Story two").checked).toBe(false);
    expect(screen.getByText("1 selected")).toBeTruthy();
    // Some, not all: the header box is neither ticked nor empty.
    expect(box("Select all user stories").indeterminate).toBe(true);
  });

  it("selects and clears every row from the header box", async () => {
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );
    await screen.findByRole("checkbox", { name: "Select Story one" });
    const all = box("Select all user stories");

    fireEvent.click(all);
    expect(box("Select Story one").checked).toBe(true);
    expect(box("Select Story two").checked).toBe(true);
    expect(all.checked).toBe(true);
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.click(all);
    expect(box("Select Story one").checked).toBe(false);
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("clears the selection from the Clear button", async () => {
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select Story two" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(box("Select Story two").checked).toBe(false);
    expect(screen.queryByText("1 selected")).toBeNull();
  });
});

describe("the personal Tasks list", () => {
  it("has no row checkboxes", async () => {
    render(
      <MemoryRouter>
        <Tasks />
      </MemoryRouter>
    );
    await screen.findByText("Task one");
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
  });
});
