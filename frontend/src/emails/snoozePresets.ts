// The snooze menu's choices, and how their times are worked out.

// TEMPORARY presets, short so a snooze can be watched coming back while the
// feature is tried out. The intended ones are 2 hours, 6 hours and tomorrow
// morning; only this list changes.
export const SNOOZE_PRESETS: ReadonlyArray<{ label: string; minutes: number }> =
  [
    { label: "2 minutes", minutes: 2 },
    { label: "10 minutes", minutes: 10 },
    { label: "30 minutes", minutes: 30 },
  ];

// When a preset ends if picked at `from`. Resolved at click time, not when the
// menu opened, so a menu left open still schedules from now.
export const snoozeEnd = (minutes: number, from = new Date()) =>
  new Date(from.getTime() + minutes * 60_000);

// When a snooze ends, in the viewer's own time zone (the server stores the
// exact moment): "5:42 PM" today, "Tomorrow 8:00 AM", "Sat 8:00 AM" within the
// week, "Oct 24, 8:00 AM" after that. The day matters once a snooze can run
// past midnight.
export const formatSnoozeTime = (when: Date, now = new Date()) => {
  const time = when.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(when) - day(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) {
    return `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

// Where a row or the open email offers Snooze. Not in Snoozed (it offers
// Unsnooze), nor where snoozing would hide nothing: Trash, Spam, Drafts.
export const canSnoozeIn = (folder: string | undefined) =>
  !["snoozed", "trash", "spam", "drafts"].includes(folder ?? "");
