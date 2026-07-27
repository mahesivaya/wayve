// The full-page story editor (the User Stories board's Edit button routes here)
// gates Save the same way the board's form does: disabled until the form
// differs from the story it loaded.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn().mockResolvedValue([
    {
      id: 7,
      task_number: 7,
      name: "As a user, I can log in",
      description: "So that my work is mine.",
      priority: 3,
      status: "todo",
      assignee: "",
      assigned_by: "",
      assignee_id: null,
      project_id: null,
      created_at: "2026-06-01T12:00:00Z",
    },
  ]),
  updateUserStoryApi: vi.fn(),
  deleteUserStoryApi: vi.fn(),
}));

vi.mock("../../api/taskStatuses", () => ({
  getTaskStatuses: vi
    .fn()
    .mockResolvedValue([
      { id: 1, slug: "todo", name: "To Do", color: "#888", category: "open" },
    ]),
}));

import StoryDetail from "../../userstories/StoryDetail";

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={["/user-stories/7"]}>
      <Routes>
        <Route path="/user-stories/:id" element={<StoryDetail />} />
      </Routes>
    </MemoryRouter>
  );

const saveButton = () =>
  screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

describe("StoryDetail — Save gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens with Save disabled — nothing has changed yet", async () => {
    renderDetail();
    await screen.findByDisplayValue("As a user, I can log in");
    expect(saveButton().disabled).toBe(true);
  });

  it("enables Save once a field changes, and re-disables when undone", async () => {
    renderDetail();
    const title = await screen.findByDisplayValue("As a user, I can log in");

    fireEvent.change(title, { target: { value: "As a user, I can log out" } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.change(title, { target: { value: "As a user, I can log in" } });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it("enables Save for a dropdown change, not just typed text", async () => {
    renderDetail();
    await screen.findByDisplayValue("As a user, I can log in");
    fireEvent.change(screen.getByRole("combobox", { name: /Priority/ }), {
      target: { value: "5" },
    });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });
});
