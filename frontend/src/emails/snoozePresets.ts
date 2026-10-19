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

// The "Custom" choice. Its field is a datetime-local input,
// whose value is a wall time with no zone ("2026-10-20T09:00"): the viewer's
// own, as picked.

// The longest snooze the server accepts (routes/email.rs MAX_SNOOZE_DAYS).
export const MAX_SNOOZE_DAYS = 366;

// A Date as the input writes it, in the viewer's zone: "YYYY-MM-DDTHH:mm".
export const toLocalInputValue = (when: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
};

// The input's value as a moment in the viewer's zone; null if incomplete.
export const fromLocalInputValue = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi);
};

// Where the custom field starts: tomorrow at 9:00, Gmail's "tomorrow morning".
export const defaultCustomSnooze = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);

// Why a custom time can't be used, or null when it can: the server takes only
// a future moment, at most a year away.
export const customSnoozeError = (
  when: Date | null,
  now = new Date()
): string | null => {
  if (!when) return "Pick a date and time.";
  if (when.getTime() <= now.getTime()) return "Pick a time in the future.";
  if (when.getTime() > now.getTime() + MAX_SNOOZE_DAYS * 86_400_000) {
    return "Snooze for at most a year.";
  }
  return null;
};
