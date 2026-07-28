// Task statuses settings page: category grouping, the inline create row, the
// permission gate, and the reassignment prompt that guards deleting a status
// tasks still reference.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { TaskStatusRow } from "../../api/taskStatuses";

const statusRows: TaskStatusRow[] = [
  {
    id: 1,
    slug: "to_do",
    name: "To Do",
    description: "",
    color: "#6b7280",
    category: "backlog",
    position: 0,
    task_count: 0,
  },
  {
    id: 2,
    slug: "in_progress",
    name: "In Progress",
    description: "Actively being worked",
    color: "#4c9aff",
    category: "in_progress",
    position: 1,
    task_count: 3,
  },
  {
    id: 3,
    slug: "done",
    name: "Done",
    description: "",
    color: "#36b37e",
    category: "completed",
    position: 2,
    task_count: 0,
  },
];

vi.mock("../../api/taskStatuses", async () => {
  const actual = await vi.importActual<typeof import("../../api/taskStatuses")>(
    "../../api/taskStatuses"
  );
  return {
    ...actual,
    getTaskStatuses: vi.fn(),
    createTaskStatus: vi.fn(),
    updateTaskStatus: vi.fn(),
    deleteTaskStatus: vi.fn(),
    reorderTaskStatuses: vi.fn(),
  };
});

// hasPermission reads the `permissions[]` the server attaches to /api/me, so
// the mock supplies that rather than a role — same shape the real app sees.
const MANAGER = { permissions: ["apps:use", "task_statuses:manage"] };
const MEMBER = { permissions: ["apps:use"] };
const mockUser: { user: { permissions: string[] } } = { user: MANAGER };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockUser }));

vi.mock("../../profile/SettingsShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import TaskStatuses from "../../settings/TaskStatuses";
import {
  createTaskStatus,
  deleteTaskStatus,
  getTaskStatuses,
  updateTaskStatus,
} from "../../api/taskStatuses";

const renderPage = () =>
  render(
    <MemoryRouter>
      <TaskStatuses />
    </MemoryRouter>
  );

describe("Task statuses settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTaskStatuses).mockResolvedValue(structuredClone(statusRows));
    mockUser.user = MANAGER;
  });

  it("groups statuses under their category headings", async () => {
    renderPage();

    await screen.findByText("To Do");
    // All five categories render as headings even when empty, so there is
    // always somewhere to add a status.
    for (const heading of [
      "Backlog",
      "Planned",
      "In Progress",
      "Completed",
      "Canceled",
    ]) {
      expect(
        screen.getAllByText(heading).length,
        `missing heading ${heading}`
      ).toBeGreaterThan(0);
    }
    expect(screen.getByText("Actively being worked")).toBeTruthy();
  });

  it("falls back to a task count for statuses with no description", async () => {
    renderPage();
    // "To Do" and "Done" both have an empty description and no tasks, so both
    // show the count instead. "In Progress" shows its description and is
    // therefore not part of this match.
    const counts = await screen.findAllByText("0 tasks");
    expect(counts).toHaveLength(2);
  });

  it("creates a status in the category whose + was clicked", async () => {
    vi.mocked(createTaskStatus).mockResolvedValue(statusRows[0]);
    renderPage();
    await screen.findByText("To Do");

    fireEvent.click(screen.getByLabelText("Add a status to Planned"));
    fireEvent.change(screen.getByLabelText("New status name"), {
      target: { value: "Scheduled" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(createTaskStatus).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Scheduled", category: "planned" })
      );
    });
  });

  it("hides editing affordances without task_statuses:manage", async () => {
    // A plain member holds only the baseline bundle.
    mockUser.user = MEMBER;
    renderPage();

    await screen.findByText("To Do");
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByLabelText("Add a status to Planned")).toBeNull();
    expect(screen.getByText(/organization's shared statuses/i)).toBeTruthy();
  });

  /**
   * Regression: the coloured chip on each row reads as the colour control, but
   * was originally inert — recolouring meant discovering "Edit", changing the
   * colour, then "Save". Clicking the chip must recolour and save on its own.
   */
  it("recolours straight from the row swatch, without entering edit mode", async () => {
    vi.mocked(updateTaskStatus).mockResolvedValue(statusRows[0]);
    renderPage();
    await screen.findByText("To Do");

    // Deliberately does NOT click Edit first.
    fireEvent.click(screen.getAllByLabelText("Choose status color")[0]);
    fireEvent.click(screen.getByLabelText("#e5484d"));

    await waitFor(() => {
      expect(updateTaskStatus).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ color: "#e5484d", name: "To Do" })
      );
    });
  });

  /**
   * Deleting a status with tasks on it must not strand them, so the page asks
   * where to move them and forwards that as `reassign_to`.
   */
  it("prompts for a destination before deleting an in-use status", async () => {
    vi.mocked(deleteTaskStatus).mockResolvedValue(undefined);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Done");
    renderPage();
    // "In Progress" is both a category heading and a status name here, so this
    // deliberately matches all of them rather than asserting a single node.
    await screen.findAllByText("In Progress");

    // The second Delete button belongs to "In Progress" (task_count 3).
    fireEvent.click(screen.getAllByText("Delete")[1]);

    await waitFor(() => {
      expect(deleteTaskStatus).toHaveBeenCalledWith(2, "done");
    });
    expect(prompt).toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("deletes a status with no tasks after a plain confirm", async () => {
    vi.mocked(deleteTaskStatus).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("To Do");

    fireEvent.click(screen.getAllByText("Delete")[0]);

    await waitFor(() => {
      // No reassignment target, since nothing referenced it.
      expect(deleteTaskStatus).toHaveBeenCalledWith(1, undefined);
    });
    confirm.mockRestore();
  });
});
