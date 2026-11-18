import type { PendingStatusChange } from "../api/ai";
import type { SaveTaskPayload, Task } from "../api/tasks";
import { getTickets, updateTicketApi } from "../api/tickets";
import { getUserStories, updateUserStoryApi } from "../api/userStories";

// Makes a status change the assistant proposed, after the user confirmed it.
//
// The boards' update endpoint replaces the whole item, so the current row is
// read first and every other field echoed back, exactly as an inline status
// change on the board does (`savePayloadFrom` in tasks/Tasks.tsx). Skipping
// that would blank the assignee, project, reviewer and type.
export async function applyStatusChange(
  change: PendingStatusChange
): Promise<Task> {
  const isTicket = change.kind === "ticket";
  const items = await (isTicket ? getTickets() : getUserStories());
  const item = items.find((t) => t.id === change.id);
  if (!item) {
    throw new Error(
      `That ${isTicket ? "ticket" : "user story"} is no longer on the board.`
    );
  }

  const payload: SaveTaskPayload = {
    name: item.name,
    description: item.description,
    priority: item.priority,
    status: change.to_status,
    assigned_by: item.assigned_by ?? "",
    assignee: item.assignee ?? "",
    assignee_id: item.assignee_id ?? null,
    project_id: item.project_id ?? null,
    reviewer: item.reviewer ?? "",
    reviewer_id: item.reviewer_id ?? null,
    // Only tickets have a type.
    ...(isTicket ? { badge_kind: item.badge_kind ?? null } : {}),
  };
  return isTicket
    ? updateTicketApi(item.id, payload)
    : updateUserStoryApi(item.id, payload);
}
