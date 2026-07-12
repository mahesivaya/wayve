// Integration test: clicking a task link inside a chat message opens the Tasks
// app in the split pane FOCUSED on just that task (not the whole list), the pane
// stays open when the task is clicked, and "Show all tasks" reveals the full
// list. Mounts the *real* MessageText and Tasks components inside a harness that
// mimics Layout's split state machine, so the openApp → paneTarget → focus
// contract is exercised.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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
    {
      id: 99,
      name: "Some other task",
      description: "Not the linked one.",
      priority: 3,
      status: "todo",
      assigned_by: null,
      assignee: null,
      assignee_id: null,
      project_id: null,
      project_key: null,
      created_at: "2026-07-02T00:00:00Z",
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
  useAuth: () => ({ user: { id: 1, email: "me@test.local", scope: "personal" } }),
}));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import MessageText from "../../chat/components/MessageText";
import Tasks from "../../tasks/Tasks";
import { SplitPaneContext } from "../../components/SplitPaneContext";
import {
  SplitControlContext,
  type SplitTarget,
} from "../../components/SplitControlContext";
import type { AppKey } from "../../components/LayoutConfig";

// Minimal Layout stand-in: holds rightView + paneTarget and provides the same
// openApp/closeApp contract Layout does, rendering Tasks as the "right pane"
// (wrapped in SplitPaneContext so it runs in its compact/inline mode).
function SplitHarness({ text }: { text: string }) {
  const [rightView, setRightView] = useState<AppKey | null>(null);
  const [paneTarget, setPaneTarget] = useState<SplitTarget | null>(null);
  const value = {
    openApp: (app: AppKey, opts?: { taskId?: number }) => {
      setRightView(app);
      setPaneTarget({ app, taskId: opts?.taskId });
    },
    target: paneTarget,
    closeApp: () => {
      setRightView(null);
      setPaneTarget(null);
    },
  };
  return (
    <MemoryRouter>
      <SplitControlContext.Provider value={value}>
        <div data-testid="left-chat">
          <MessageText text={text} />
        </div>
        {rightView === "tasks" && (
          <div data-testid="right-pane">
            <SplitPaneContext.Provider value={true}>
              <Tasks />
            </SplitPaneContext.Provider>
          </div>
        )}
      </SplitControlContext.Provider>
    </MemoryRouter>
  );
}

describe("task link → split pane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the pane focused on the linked task, stays open on click, and 'Show all tasks' reveals the list", async () => {
    const url = `${window.location.origin}/tasks?task=42`;
    render(<SplitHarness text={`Take a look: ${url}`} />);

    // Pane closed initially.
    expect(screen.queryByTestId("right-pane")).toBeNull();

    // Click the task link in the chat message.
    await userEvent.click(screen.getByRole("link", { name: url }));

    // The Tasks pane appears...
    const pane = await screen.findByTestId("right-pane");
    expect(pane).toBeTruthy();
    // ...focused on THIS task: its detail is visible and the other task is not
    // in the list (proving it opened the specific task, not the whole list).
    await waitFor(() =>
      expect(screen.getByText("The linked task.")).toBeTruthy()
    );
    expect(
      screen.queryByRole("button", { name: "Some other task" })
    ).toBeNull();

    // Clicking the task title opens its full details (the edit modal) and keeps
    // the pane open.
    await userEvent.click(
      screen.getByRole("button", { name: "Ship the thing" })
    );
    await waitFor(() => expect(screen.getByText("Edit Task")).toBeTruthy());
    expect(screen.queryByTestId("right-pane")).not.toBeNull();

    // Close the modal, then "Show all tasks" reveals the full list.
    await userEvent.click(screen.getByRole("button", { name: "Close modal" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Show all tasks" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Some other task" })
      ).toBeTruthy()
    );
    expect(screen.queryByTestId("right-pane")).not.toBeNull();
  });
});
