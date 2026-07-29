// The full-page ticket editor gates Save the same way the board's form and the
// story page do: disabled until the form differs from the ticket it loaded.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../api/tickets", () => ({
  getTickets: vi.fn().mockResolvedValue([
    {
      id: 4,
      task_number: 4,
      name: "Login button does nothing",
      description: "Clicking it on Safari is a no-op.",
      priority: 3,
      status: "todo",
      assignee: "",
      assigned_by: "",
      assignee_id: null,
      project_id: null,
      created_at: "2026-06-01T12:00:00Z",
    },
  ]),
  updateTicketApi: vi.fn(),
  deleteTicketApi: vi.fn(),
}));

vi.mock("../../api/taskStatuses", () => ({
  getTaskStatuses: vi
    .fn()
    .mockResolvedValue([
      { id: 1, slug: "todo", name: "To Do", color: "#888", category: "open" },
    ]),
}));

import TicketDetail from "../../tickets/TicketDetail";

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={["/tickets/4"]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>
  );

const saveButton = () =>
  screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

describe("TicketDetail — Save gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens with Save disabled — nothing has changed yet", async () => {
    renderDetail();
    await screen.findByDisplayValue("Login button does nothing");
    expect(saveButton().disabled).toBe(true);
  });

  it("enables Save once a field changes, and re-disables when undone", async () => {
    renderDetail();
    const title = await screen.findByDisplayValue("Login button does nothing");

    fireEvent.change(title, { target: { value: "Login button is dead" } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.change(title, { target: { value: "Login button does nothing" } });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });
});
