import { useEffect, useState } from "react";
import { getEmailsUnreadCount } from "../api/email";
import { EMAILS_SYNCED_EVENT } from "./useEmailLiveRefresh";

// Fired by `markEmailRead` and the bulk mark-read path so mounted badges
// refresh immediately instead of waiting for the next 60s poll.
export const EMAILS_UNREAD_CHANGED_EVENT = "rwayve:emails-unread-changed";

// Cheap: the backend query is index-only against idx_emails_unread. `enabled`
// gates the fetch on auth state, so passing `false` during logout keeps the
// badge from firing a 401.
export function useEmailsUnreadCount(enabled: boolean = true): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      getEmailsUnreadCount()
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
    window.addEventListener(EMAILS_UNREAD_CHANGED_EVENT, onChanged);
    // The server just synced a mailbox on a provider push.
    window.addEventListener(EMAILS_SYNCED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(EMAILS_UNREAD_CHANGED_EVENT, onChanged);
      window.removeEventListener(EMAILS_SYNCED_EVENT, onChanged);
    };
  }, [enabled]);

  return count;
}
