// The User Stories list lets a story's priority be changed straight from its
// row, like its status, without opening the editor.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const story = {
  id: 2,
  task_number: 2,
  name: "Login Security",
  description: "Harden sign-in.",
  priority: 3,
  status: "todo",
  assignee: "",
  assigned_by: "",
  assignee_id: null,
  project_id: null,
  created_at: "2026-06-01T12:00:00Z",
};

vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn(),
  createUserStoryApi: vi.fn(),
  updateUserStoryApi: vi.fn(),
  deleteUserStoryApi: vi.fn(),
}));

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([]),
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

import { getUserStories, updateUserStoryApi } from "../../api/userStories";
import UserStories from "../../userstories/UserStories";

describe("User Stories — inline priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(getUserStories).mockResolvedValue([story] as never);
  });

  it("changes a story's priority from its row", async () => {
    vi.mocked(updateUserStoryApi).mockResolvedValue({
      ...story,
      priority: 1,
    } as never);
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );

    const select = (await screen.findByLabelText(
      "Priority of Login Security"
    )) as HTMLSelectElement;
    expect(select.value).toBe("3");

    fireEvent.change(select, { target: { value: "1" } });

    await waitFor(() =>
      expect(updateUserStoryApi).toHaveBeenCalledWith(
        2,
        expect.objectContaining({
          priority: 1,
          name: "Login Security",
          description: "Harden sign-in.",
          status: "todo",
        })
      )
    );
    await waitFor(() => expect(select.value).toBe("1"));
  });

  it.each([
    ["Grid view", "grid", "tasks"],
    ["Columns view", "list", "jira"],
  ])("is editable in the %s too", async (_name, view, mode) => {
    window.localStorage.setItem("wayve.userstories.view", view);
    window.localStorage.setItem("wayve.userstories.mode", mode);
    vi.mocked(updateUserStoryApi).mockResolvedValue({
      ...story,
      priority: 5,
    } as never);
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );
    const select = (await screen.findByLabelText(
      "Priority of Login Security"
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() =>
      expect(updateUserStoryApi).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ priority: 5, name: "Login Security" })
      )
    );
  });
});
