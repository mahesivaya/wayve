import { useEffect, useState } from "react";
import { getTicketsOpenCount, TICKETS_CHANGED_EVENT } from "../api/tickets";

// Number of workspace tickets not in a terminal (completed/canceled) column,
// for the Workspace sidebar badge. Mirrors useEmailsUnreadCount: `enabled`
// gates the fetch on auth state so it never fires a 401 during logout, it polls
// on an interval, refreshes when the tab becomes visible, and reacts instantly
// to TICKETS_CHANGED_EVENT dispatched by the ticket write helpers.
export function useTicketsOpenCount(enabled: boolean = true): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      getTicketsOpenCount()
        .then((n) => {
          if (!cancelled) setCount(n);
        })
        .catch(() => {
          // Keep previous count on transient failure; the next poll retries.
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 60_000);

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    const onChanged = () => refresh();
    window.addEventListener(TICKETS_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(TICKETS_CHANGED_EVENT, onChanged);
    };
  }, [enabled]);

  return count;
}
