import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { TaskStatusRow } from "../../api/taskStatuses";

const rows: TaskStatusRow[] = [
  { id: 1, slug: "to_do", name: "To Do", description: "", color: "#6b7280", category: "backlog", position: 0, task_count: 0 },
];

vi.mock("../../api/taskStatuses", async () => {
  const actual = await vi.importActual<typeof import("../../api/taskStatuses")>("../../api/taskStatuses");
  return { ...actual, getTaskStatuses: vi.fn(), createTaskStatus: vi.fn(), updateTaskStatus: vi.fn(), deleteTaskStatus: vi.fn(), reorderTaskStatuses: vi.fn() };
});
const mockUser = { user: { permissions: ["apps:use", "task_statuses:manage"] } };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockUser }));
vi.mock("../../profile/SettingsShell", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import TaskStatuses from "../../settings/TaskStatuses";
import { getTaskStatuses, updateTaskStatus } from "../../api/taskStatuses";

describe("changing a status colour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTaskStatuses).mockResolvedValue(structuredClone(rows));
    vi.mocked(updateTaskStatus).mockResolvedValue(rows[0]);
  });

  it("saves the newly picked colour straight from the row, no edit mode", async () => {
    render(<MemoryRouter><TaskStatuses /></MemoryRouter>);
    await screen.findByText("To Do");

    // Deliberately does NOT click Edit — the row swatch must work on its own.
    fireEvent.click(screen.getByLabelText("Choose status color"));
    // pick a specific swatch
    fireEvent.click(screen.getByLabelText("#e5484d"));

    await waitFor(() => {
      expect(updateTaskStatus).toHaveBeenCalledWith(1, expect.objectContaining({ color: "#e5484d" }));
    });
  });
});
