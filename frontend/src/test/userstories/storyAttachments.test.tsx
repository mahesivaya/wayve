// A file picked in the Create Story form is uploaded to the new story once it
// exists, through the story-scoped attachment endpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// vi.mock factories are hoisted above the file's own declarations.
const { create, upload } = vi.hoisted(() => ({
  create: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn().mockResolvedValue([]),
  createUserStoryApi: (payload: Record<string, unknown>) => create(payload),
  updateUserStoryApi: vi.fn(),
  deleteUserStoryApi: vi.fn(),
  listStoryAttachments: vi.fn().mockResolvedValue([]),
  uploadStoryAttachments: (id: number, files: File[]) => upload(id, files),
  deleteStoryAttachment: vi.fn(),
  downloadStoryAttachment: vi.fn(),
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

import UserStories from "../../userstories/UserStories";

describe("attaching a file while creating a story", () => {
  beforeEach(() => {
    window.localStorage.clear();
    create.mockReset();
    upload.mockReset();
    create.mockResolvedValue({
      id: 9,
      task_number: 1,
      name: "Checkout flow",
      description: "",
      priority: 3,
      status: "todo",
    });
    upload.mockResolvedValue([]);
  });

  it("offers Attach files and uploads the file to the new story", async () => {
    render(
      <MemoryRouter>
        <UserStories />
      </MemoryRouter>
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "+ Create story" })
    );
    expect(
      await screen.findByRole("button", { name: "Attach files" })
    ).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Story title"), {
      target: { value: "Checkout flow" },
    });
    const file = new File(["spec"], "spec.md", { type: "text/markdown" });
    const input = document.querySelector(
      ".task-attachments-input"
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    // Queued in the form until the story is saved.
    expect(await screen.findByText("spec.md")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create story" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(9, [file]);
  });
});
