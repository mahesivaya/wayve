// The Reviewer column on the stories board: a dropdown of members like
// Assignee, saved on change. It is on by default, including for someone whose
// column choice was saved before the column existed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// vi.mock factories are hoisted above the file's own declarations.
const { create, update, story } = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  story: {
    id: 1,
    task_number: 1,
    name: "Checkout flow",
    description: "",
    priority: 3,
    status: "todo",
    assigned_by: "",
    assignee: "ann@test.local",
    assignee_id: 11,
    reviewer: "",
    reviewer_id: null,
    created_at: "2026-07-01T12:00:00Z",
  },
}));

vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn().mockResolvedValue([story]),
  createUserStoryApi: (payload: Record<string, unknown>) => create(payload),
  updateUserStoryApi: (id: number, payload: Record<string, unknown>) =>
    update(id, payload),
  deleteUserStoryApi: vi.fn(),
  listStoryAttachments: vi.fn().mockResolvedValue([]),
  uploadStoryAttachments: vi.fn(),
  deleteStoryAttachment: vi.fn(),
  downloadStoryAttachment: vi.fn(),
}));

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([]),
  getProjects: vi.fn().mockResolvedValue([]),
  getAssignableUsers: vi.fn().mockResolvedValue([
    { user_id: 11, email: "ann@test.local", username: "Ann" },
    { user_id: 12, email: "bo@test.local", username: "Bo" },
  ]),
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
    user: { id: 1, email: "me@test.local", scope: "organization" },
  }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import UserStories from "../../userstories/UserStories";

const renderBoard = () =>
  render(
    <MemoryRouter>
      <UserStories />
    </MemoryRouter>
  );
const header = () => document.querySelector(".task-thead") as HTMLElement;
const reviewer = () =>
  screen.findByLabelText(
    "Reviewer of Checkout flow"
  ) as Promise<HTMLSelectElement>;

describe("the Reviewer column on user stories", () => {
  beforeEach(() => {
    window.localStorage.clear();
    update.mockReset();
    create.mockReset();
    create.mockImplementation((payload: object) =>
      Promise.resolve({ ...story, id: 2, task_number: 2, ...payload })
    );
    update.mockImplementation((_id: number, payload: object) =>
      Promise.resolve({ ...story, ...payload })
    );
  });

  it("shows beside Assignee with nobody picked yet", async () => {
    renderBoard();
    const select = await reviewer();
    expect(header().textContent).toMatch(/Assignee.*Reviewer/);
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "No reviewer",
      "Ann",
      "Bo",
    ]);
  });

  it("saves the picked reviewer and keeps the assignee", async () => {
    renderBoard();
    const select = await reviewer();
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "bo@test.local" } });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        reviewer: "bo@test.local",
        reviewer_id: 12,
        assignee: "ann@test.local",
        assignee_id: 11,
      })
    );
    expect((await reviewer()).value).toBe("bo@test.local");
  });

  it("appears for a column choice saved before the column existed", async () => {
    // An older build saved this list; it had no way to say yes or no to
    // Reviewer.
    window.localStorage.setItem(
      "wayve.userstories.cols",
      JSON.stringify(["title", "assignee", "status"])
    );
    renderBoard();
    await reviewer();
    expect(header().textContent).not.toMatch(/Created/);
    expect(header().textContent).toMatch(/Reviewer/);
  });

  it("stays hidden once it has been switched off", async () => {
    window.localStorage.setItem(
      "wayve.userstories.cols",
      JSON.stringify(["title", "assignee", "status"])
    );
    window.localStorage.setItem(
      "wayve.userstories.colsKnown",
      JSON.stringify(["title", "assignee", "reviewer", "status"])
    );
    renderBoard();
    await screen.findByText("Checkout flow");
    expect(header().textContent).not.toMatch(/Reviewer/);
  });

  it("can be picked in the create form and is sent with the new story", async () => {
    renderBoard();
    fireEvent.click(
      await screen.findByRole("button", { name: "+ Create story" })
    );
    fireEvent.change(await screen.findByPlaceholderText("Story title"), {
      target: { value: "Refund flow" },
    });
    // The form's Reviewer pill opens the same member menu Assignee uses.
    fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    const menu = await screen.findByRole("dialog", { name: "Choose reviewer" });
    expect(menu.textContent).toContain("No reviewer");
    fireEvent.click(within(menu).getByText("Bo"));
    // The pill now names the reviewer.
    expect(screen.getByRole("button", { name: "Bo" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create story" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Refund flow",
        reviewer: "bo@test.local",
        reviewer_id: 12,
      })
    );
  });

  it("is loaded into the edit form and only saved when changed", async () => {
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "NON001" }));
    const form = await screen.findByRole("dialog", { name: "Edit Story" });
    const save = within(form).getByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(form).getByRole("button", { name: "Reviewer" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Choose reviewer" })
      ).getByText("Ann")
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reviewer: "ann@test.local", reviewer_id: 11 })
    );
  });
});
