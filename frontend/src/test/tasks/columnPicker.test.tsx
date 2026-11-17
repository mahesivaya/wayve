// List-view Columns menu: optional columns can be shown and hidden, the choice
// survives a remount, the search narrows the list, and Reset restores the
// default set. Only columns the board supports are offered.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 1,
      task_number: 7,
      name: "Fix the login redirect",
      description: "Users land on a blank page after signing in",
      priority: 3,
      status: "todo",
      project_id: 5,
      created_at: "2026-07-01T12:00:00Z",
      updated_at: "2026-07-03T12:00:00Z",
    },
  ]),
  getProjects: vi.fn().mockResolvedValue([
    { id: 5, name: "Wayve", github_owner: null, github_repo: null },
    { id: 6, name: "Mobile", github_owner: null, github_repo: null },
  ]),
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

const header = () => document.querySelector(".task-thead") as HTMLElement;
const openMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
const menu = () => screen.getByRole("dialog", { name: "Columns" });

describe("list-view Columns menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("offers only the columns this board supports", async () => {
    renderTasks();
    await screen.findByText("Fix the login redirect");
    openMenu();
    const labels = within(menu())
      .getAllByRole("checkbox")
      .map((box) => box.closest("label")?.textContent);
    // Personal task board: no ticket-only or team-only columns.
    expect(labels).toEqual([
      "Created",
      "Key",
      "Project",
      "Priority",
      "Status",
      "Updated",
      "Description",
    ]);
    expect(within(menu()).getByText("3 of 7")).toBeTruthy();
  });

  it("shows a column when it's ticked and keeps it after a remount", async () => {
    const first = renderTasks();
    await screen.findByText("Fix the login redirect");
    expect(within(header()).queryByText("Updated")).toBeNull();

    openMenu();
    fireEvent.click(within(menu()).getByLabelText("Updated"));
    expect(within(header()).getByText(/Updated/)).toBeTruthy();
    expect(screen.getByText("Jul 3, 2026")).toBeTruthy();

    first.unmount();
    renderTasks();
    await screen.findByText("Fix the login redirect");
    expect(within(header()).getByText(/Updated/)).toBeTruthy();
  });

  it("hides a default column when it's unticked, and Reset brings it back", async () => {
    renderTasks();
    await screen.findByText("Fix the login redirect");
    openMenu();
    fireEvent.click(within(menu()).getByLabelText("Created"));
    expect(within(header()).queryByText(/Created/)).toBeNull();

    fireEvent.click(within(menu()).getByText("Reset to default"));
    expect(within(header()).getByText(/Created/)).toBeTruthy();
  });

  it("moves the key into its own column and lets the project be changed inline", async () => {
    renderTasks();
    await screen.findByText("Fix the login redirect");
    openMenu();
    fireEvent.click(within(menu()).getByLabelText("Key"));
    fireEvent.click(within(menu()).getByLabelText("Project"));

    const keyCell = document.querySelector(".task-tcell--key") as HTMLElement;
    expect(within(keyCell).getByText("way7")).toBeTruthy();
    // Not duplicated next to the title any more.
    const titleCell = document.querySelector(
      ".task-tcell--title"
    ) as HTMLElement;
    expect(within(titleCell).queryByText("way7")).toBeNull();

    const project = screen.getByLabelText(
      "Project of Fix the login redirect"
    ) as HTMLSelectElement;
    expect(project.value).toBe("5");
  });

  it("keeps Delete out of the rows and in the edit form", async () => {
    renderTasks();
    await screen.findByText("Fix the login redirect");
    const table = document.querySelector(".task-table") as HTMLElement;
    expect(within(table).queryByRole("button", { name: /delete/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Fix the login redirect" })
    );
    expect(await screen.findByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("narrows the list with the search box", async () => {
    renderTasks();
    await screen.findByText("Fix the login redirect");
    openMenu();
    fireEvent.change(within(menu()).getByLabelText("Search columns"), {
      target: { value: "desc" },
    });
    expect(within(menu()).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(menu()).getByLabelText("Description")).toBeTruthy();
  });
});
