// The User Stories edit drawer covers the whole window on a full page, but stays
// inside the board in a split pane so the other panes remain usable.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn().mockResolvedValue([
    {
      id: 1,
      task_number: 1,
      name: "Story one",
      description: "ok",
      priority: 3,
      status: "todo",
      created_at: "2026-06-01T12:00:00Z",
    },
  ]),
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

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@test.local", scope: "personal" },
  }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import { SplitPaneContext } from "../../components/SplitPaneContext";
import UserStories from "../../userstories/UserStories";

const openDrawer = async (inSplitPane: boolean) => {
  render(
    <MemoryRouter>
      <SplitPaneContext.Provider value={inSplitPane}>
        <UserStories />
      </SplitPaneContext.Provider>
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: "Story one" }));
  return screen.getByRole("dialog", { name: "Edit Story" });
};

describe("User Stories edit drawer", () => {
  it("stays inside the board in a split pane", async () => {
    const drawer = await openDrawer(true);
    expect(drawer.className).toContain("task-drawer--contained");
    expect(drawer.closest(".tasks-app")).not.toBeNull();
    expect(
      document.querySelector(".task-drawer-overlay--contained")
    ).not.toBeNull();
  });

  it("covers the window on a full page", async () => {
    const drawer = await openDrawer(false);
    expect(drawer.className).not.toContain("task-drawer--contained");
    expect(
      document.querySelector(".task-drawer-overlay--contained")
    ).toBeNull();
  });

  it("ignores Escape from another pane when contained", async () => {
    const drawer = await openDrawer(true);
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Edit Story" })).toBe(drawer);
    elsewhere.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit Story" })).toBeNull();
  });
});
