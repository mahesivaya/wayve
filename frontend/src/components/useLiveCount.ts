import { useEffect, useState } from "react";

import { listenAcrossTabs } from "../utils/crossTabEvents";

// How often a visible tab re-checks, for changes no signal reports (another
// user's edits, server-side jobs). The count endpoints are cheap single queries.
export const LIVE_COUNT_POLL_MS = 20_000;

/**
 * A sidebar badge count that stays current. It fetches on mount, then again:
 * - at once when `changeEvent` fires, from this tab or (via crossTabEvents)
 *   another one;
 * - when the window regains focus or the tab becomes visible;
 * - every LIVE_COUNT_POLL_MS while the tab is visible (hidden tabs skip the
 *   poll and catch up on becoming visible).
 *
 * `enabled` gates every fetch on auth state so none fires a 401 during logout.
 * A failed fetch keeps the previous count; the next trigger retries.
 */
export function useLiveCount(
  fetchCount: () => Promise<number>,
  changeEvent: string,
  enabled: boolean = true
): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listenAcrossTabs();

    const refresh = () => {
      fetchCount()
        .then((n) => {
          if (!cancelled) setCount(n);
        })
        .catch(() => {
          // Keep the previous count on a transient failure.
        });
    };
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    const interval = window.setInterval(refreshIfVisible, LIVE_COUNT_POLL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refresh);
    window.addEventListener(changeEvent, refresh);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(changeEvent, refresh);
    };
  }, [fetchCount, changeEvent, enabled]);

  return count;
}
