import { useEffect, useState } from "react";
import { getReminders } from "../api/reminders";

const REFRESH_MS = 60_000;

// Count of the user's reminders, for the sidebar "Reminders" badge — so the
// badge matches the reminders list instead of the old unread-mail/chat total.
// Polls on an interval and refreshes immediately when a reminder is created or
// deleted (the `rwayve:reminders-changed` event fired by the api layer).
export function useRemindersCount(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // No reset when disabled: the badge's owner renders nothing without a user,
    // so a stale count is never shown, and this avoids a synchronous setState.
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const reminders = await getReminders();
        if (alive) setCount(reminders.length);
      } catch {
        // Best-effort: keep the last count on a failed pull.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onChanged = () => void load();
    window.addEventListener("rwayve:reminders-changed", onChanged);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("rwayve:reminders-changed", onChanged);
    };
  }, [enabled]);

  return count;
}
