// The assistant can propose moving a user story or ticket to another status.
// Nothing is saved until the user confirms the card; confirming goes through
// the board's own update endpoint, echoing every other field back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../api/ai", () => ({
  getAiProvider: vi.fn().mockResolvedValue({ provider: null, model: null }),
  sendAiChat: vi.fn(),
}));
vi.mock("../../api/email", () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  sendEmail: vi.fn(),
}));
vi.mock("../../api/userStories", () => ({
  getUserStories: vi.fn(),
  updateUserStoryApi: vi.fn(),
}));
vi.mock("../../api/tickets", () => ({
  getTickets: vi.fn(),
  updateTicketApi: vi.fn(),
}));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));
vi.mock("../../auth/useAuth", () => ({ useAuth: () => ({ user: null }) }));

import AIChat from "../../aichat/AIChat";
import { applyStatusChange } from "../../aichat/applyStatusChange";
import { sendAiChat, type PendingStatusChange } from "../../api/ai";
import { getUserStories, updateUserStoryApi } from "../../api/userStories";
import { getTickets, updateTicketApi } from "../../api/tickets";

const story = {
  id: 7,
  task_number: 4,
  name: "Checkout flow",
  description: "Pay by card",
  priority: 2,
  status: "todo",
  assigned_by: "lead@test.local",
  assignee: "dev@test.local",
  assignee_id: 12,
  project_id: 3,
  reviewer: "bo@test.local",
  reviewer_id: 15,
};

const move: PendingStatusChange = {
  type: "set_status",
  kind: "user_story",
  id: 7,
  key: "SAM004",
  name: "Checkout flow",
  from_status: "To Do",
  to_status: "completed",
  to_status_name: "Completed",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserStories).mockResolvedValue([story] as never);
  vi.mocked(updateUserStoryApi).mockResolvedValue(story as never);
  vi.mocked(getTickets).mockResolvedValue([] as never);
});

const ask = async () => {
  vi.mocked(sendAiChat).mockResolvedValue({
    reply: "I've set that up for you to confirm.",
    pending_actions: [move],
  });
  render(<AIChat />);
  await userEvent.type(
    screen.getByPlaceholderText(/Message AI/),
    "move SAM004 to completed{Enter}"
  );
  return screen.findByText(/Move user story/);
};

describe("a status change the assistant proposes", () => {
  it("shows a card and saves nothing until confirmed", async () => {
    await ask();
    expect(screen.getByText("SAM004 Checkout flow")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(updateUserStoryApi).not.toHaveBeenCalled();
  });

  it("moves the story on Confirm, keeping its other fields", async () => {
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    await screen.findByText(/Moved to Completed/);

    expect(updateUserStoryApi).toHaveBeenCalledTimes(1);
    expect(updateUserStoryApi).toHaveBeenCalledWith(7, {
      name: "Checkout flow",
      description: "Pay by card",
      priority: 2,
      status: "completed",
      assigned_by: "lead@test.local",
      assignee: "dev@test.local",
      assignee_id: 12,
      project_id: 3,
      reviewer: "bo@test.local",
      reviewer_id: 15,
    });
    // Confirmed once: the buttons are gone, so it cannot be sent twice.
    expect(screen.queryByRole("button", { name: "Confirm move" })).toBeNull();
  });

  it("drops the card on Cancel without saving", async () => {
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText(/Move user story/)).toBeNull()
    );
    expect(updateUserStoryApi).not.toHaveBeenCalled();
  });

  it("reports a story that has since been deleted", async () => {
    await ask();
    vi.mocked(getUserStories).mockResolvedValue([] as never);
    await userEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    expect(await screen.findByText(/no longer on the board/)).toBeTruthy();
    expect(updateUserStoryApi).not.toHaveBeenCalled();
  });
});

describe("applyStatusChange", () => {
  it("sends a ticket's type back with the move", async () => {
    vi.mocked(getTickets).mockResolvedValue([
      { ...story, id: 9, badge_kind: "bug" },
    ] as never);
    vi.mocked(updateTicketApi).mockResolvedValue(story as never);

    await applyStatusChange({ ...move, kind: "ticket", id: 9 });

    expect(updateTicketApi).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ status: "completed", badge_kind: "bug" })
    );
    expect(updateUserStoryApi).not.toHaveBeenCalled();
  });
});
