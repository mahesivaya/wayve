import { useEffect, useState } from "react";
import { getChatConversationSummary } from "../api/chat";

// Custom event other chat surfaces can fire after marking a conversation read
// so the sidebar badge refreshes immediately instead of waiting for the poll.
export const CHAT_UNREAD_CHANGED_EVENT = "rwayve:chat-unread-changed";

// Subscribe to the total unread chat (direct-message) count. Mirrors
// useEmailsUnreadCount: used by the Layout sidebar's Chat nav badge.
//
// `enabled` lets callers gate the fetch on auth state — passing `false`
// while the user is logging out keeps the badge from firing a 401.
export function useChatUnreadCount(enabled: boolean = true): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      getChatConversationSummary()
        .then((summary) => {
          if (!cancelled) setCount(summary.total_unread ?? 0);
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

    // The chat page fires this with the fresh total in `detail` (instant, no
    // refetch); other emitters may fire it bare → fall back to a refetch.
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number" && !cancelled) setCount(detail);
      else refresh();
    };
    window.addEventListener(CHAT_UNREAD_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHAT_UNREAD_CHANGED_EVENT, onChanged);
    };
  }, [enabled]);

  return count;
}
