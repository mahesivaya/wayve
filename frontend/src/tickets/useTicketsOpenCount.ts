import { useLiveCount } from "../components/useLiveCount";
import { getTicketsOpenCount, TICKETS_CHANGED_EVENT } from "../api/tickets";

// Number of workspace tickets not in a terminal (completed/canceled) column,
// for the Workspace sidebar badge. Refreshes on any ticket write in any open
// tab (TICKETS_CHANGED_EVENT), on focus/visibility, and on a short poll for
// changes made elsewhere — see useLiveCount.
export function useTicketsOpenCount(enabled: boolean = true): number {
  return useLiveCount(getTicketsOpenCount, TICKETS_CHANGED_EVENT, enabled);
}
