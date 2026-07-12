// A chat task link navigates to /tasks?task=<id>, which opens the task's
// details modal directly. Closing that modal returns the user to Messages
// (/chat) rather than leaving them on the full task list.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../../api/tasks", () => ({
  getTasks: vi.fn().mockResolvedValue([
    {
      id: 42,
      name: "Ship the thing",
      description: "The linked task.",
      priority: 2,
      status: "todo",
      assigned_by: null,
      assignee: null,
      assignee_id: null,
      project_id: null,
      project_key: null,
      created_at: "2026-07-01T00:00:00Z",
    },
  ]),
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

import Tasks from "../../tasks/Tasks";

describe("task link → close returns to Messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the linked task, then navigates to /chat on close", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks?task=42"]}>
        <Routes>
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/chat" element={<div>Messages page</div>} />
        </Routes>
      </MemoryRouter>
    );

    // The deep link opens the task's details modal directly.
    await waitFor(() => expect(screen.getByText("Edit Task")).toBeTruthy());
    expect(screen.getByDisplayValue("Ship the thing")).toBeTruthy();

    // Closing the modal returns to Messages.
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await waitFor(() =>
      expect(screen.getByText("Messages page")).toBeTruthy()
    );
  });
});
