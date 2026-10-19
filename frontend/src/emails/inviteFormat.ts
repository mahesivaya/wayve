import type { EmailInvite } from "../api/email";

// What kind of calendar message it is, for the card's label.
export const inviteLabel = (invite: EmailInvite): string => {
  if (invite.status === "cancelled" || invite.method === "cancel") {
    return "Cancelled";
  }
  if (invite.method === "reply") return "Reply";
  return "Invitation";
};

const dateText = (d: Date) =>
  d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const timeText = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// "2026-10-24" as a local date (not UTC midnight, which can land on the day
// before in the Americas).
const localDate = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// "2026-10-20T10:00:00" as written, for a zone we can't convert from.
const wallTime = (value: string) => {
  const [date, time = "00:00:00"] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
};

// When the meeting is, in the viewer's own time zone: "Tue, Oct 20, 2026 ·
// 3:00 PM – 3:30 PM". All-day events show dates (iCalendar's end date is
// exclusive); a time in a zone we couldn't read is shown as written, with the
// zone's name. Null when the invite has no time at all.
export const inviteWhen = (invite: EmailInvite): string | null => {
  if (invite.all_day && invite.start_date) {
    const start = localDate(invite.start_date);
    const end = invite.end_date ? localDate(invite.end_date) : null;
    if (end) end.setDate(end.getDate() - 1);
    return end && end.getTime() > start.getTime()
      ? `${dateText(start)} – ${dateText(end)} · All day`
      : `${dateText(start)} · All day`;
  }
  const exact = invite.start ? new Date(invite.start) : null;
  const start = exact ?? (invite.start_local ? wallTime(invite.start_local) : null);
  if (!start) return null;
  const end = invite.end
    ? new Date(invite.end)
    : invite.end_local
      ? wallTime(invite.end_local)
      : null;
  const zone = exact ? "" : invite.time_zone ? ` (${invite.time_zone})` : "";
  if (!end) return `${dateText(start)} · ${timeText(start)}${zone}`;
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${dateText(start)} · ${timeText(start)} – ${timeText(end)}${zone}`
    : `${dateText(start)} ${timeText(start)} – ${dateText(end)} ${timeText(end)}${zone}`;
};
