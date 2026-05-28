import { useEffect, useState } from "react";
import { getEmailsUnreadCount } from "../api/email";

// Custom event name fired by `markEmailRead` (api/email.ts) and the bulk
// mark-read path so any mounted unread-count badges refresh immediately
// instead of waiting for the next 60s poll.
export const EMAILS_UNREAD_CHANGED_EVENT = "rwayve:emails-unread-changed";

// Subscribe to the global unread count. Used by the Layout sidebar's Emails
// nav badge and the EmailSidebar's "All Accounts" badge. Cheap because the
// backend query is index-only (idx_emails_unread partial index).
//
// `enabled` lets callers gate the fetch on auth state — passing `false`
// while the user is logging out keeps the badge from firing a 401.
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

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(EMAILS_UNREAD_CHANGED_EVENT, onChanged);
    };
  }, [enabled]);

  return count;
}
