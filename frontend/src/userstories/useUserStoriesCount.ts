import { useEffect, useState } from "react";
import { getUserStories } from "../api/userStories";

// Number of user stories in the owner's backlog, for the Workspace sidebar
// badge. Mirrors useTicketsOpenCount: `enabled` gates the fetch on auth state so
// it never fires a 401 during logout, it polls on an interval, and refreshes
// when the tab becomes visible. Reuses the existing list endpoint (no dedicated
// count route), counting the rows it already returns.
export function useUserStoriesCount(enabled: boolean = true): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      getUserStories()
        .then((stories) => {
          if (!cancelled) setCount(stories.length);
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

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return count;
}
