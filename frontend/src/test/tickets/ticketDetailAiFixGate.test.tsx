// "Fix with AI" is offered only on the low-stakes end of the priority scale —
// P4 (Low) and P5 (Lowest). On the 1-highest scale that means the button shows
// for the *larger* numbers. The backend enforces the same gate, so this only
// covers what the editor puts in front of the user.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { getTickets } = vi.hoisted(() => ({ getTickets: vi.fn() }));

vi.mock("../../api/tickets", () => ({
  getTickets,
  updateTicketApi: vi.fn(),
  deleteTicketApi: vi.fn(),
  aiFixTicket: vi.fn(),
  getAiFixState: vi.fn().mockResolvedValue(null),
  commitAiFix: vi.fn(),
  pushAiFix: vi.fn(),
  openAiFixPr: vi.fn(),
}));

vi.mock("../../api/taskStatuses", () => ({
  getTaskStatuses: vi
    .fn()
    .mockResolvedValue([
      { id: 1, slug: "todo", name: "To Do", color: "#888", category: "open" },
    ]),
}));

import TicketDetail from "../../tickets/TicketDetail";

const ticketAt = (priority: number) => ({
  id: 4,
  task_number: 4,
  name: "Tooltip is misaligned",
  description: "Only on Safari.",
  priority,
  status: "todo",
  assignee: "",
  assigned_by: "",
  assignee_id: null,
  project_id: null,
  created_at: "2026-06-01T12:00:00Z",
});

const renderAt = async (priority: number) => {
  getTickets.mockResolvedValue([ticketAt(priority)]);
  render(
    <MemoryRouter initialEntries={["/tickets/4"]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>
  );
  // The form is populated before we assert on the action row.
  await screen.findByDisplayValue("Tooltip is misaligned");
};

const aiFixButton = () => screen.queryByRole("button", { name: /Fix with AI/ });

describe("TicketDetail — Fix with AI priority gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([4, 5])("offers the AI fix on P%i", async (priority) => {
    await renderAt(priority);
    expect(aiFixButton()).not.toBeNull();
  });

  it.each([1, 2, 3])("hides the AI fix on P%i", async (priority) => {
    await renderAt(priority);
    expect(aiFixButton()).toBeNull();
  });
});
