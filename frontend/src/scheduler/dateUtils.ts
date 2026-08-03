import { APP_TIME_ZONE } from "../utils/datetime";

export function formatDateLocal(date: Date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function fromTime(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function toTime(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function todayStr() {
  return formatDateLocal(new Date());
}

export function nowTimeStr() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export function addMinutesToTime(time: string, minutes: number) {
  return toTime(Math.min(toMinutes(time) + minutes, 23 * 60 + 59));
}

// Free-typed times, so a picker's presets are a shortcut rather than the only
// reachable values. Accepts "9", "930", "9:07", "9:07 pm", "9 pm", "21:45";
// returns "HH:MM", or null when the text isn't a time.
export function parseTimeInput(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\./g, "");
  if (!text) return null;

  const meridiemMatch = text.match(/(am|pm|a|p)$/);
  const meridiem = meridiemMatch ? meridiemMatch[1][0] : null;
  const digits = (
    meridiemMatch ? text.slice(0, -meridiemMatch[1].length) : text
  ).trim();

  let hours: number;
  let minutes: number;
  if (digits.includes(":")) {
    const [h, m = "0"] = digits.split(":");
    if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m)) return null;
    hours = Number(h);
    minutes = Number(m);
  } else if (/^\d{1,2}$/.test(digits)) {
    hours = Number(digits);
    minutes = 0;
  } else if (/^\d{3,4}$/.test(digits)) {
    // Separator-less entry: the last two digits are always the minutes.
    hours = Number(digits.slice(0, -2));
    minutes = Number(digits.slice(-2));
  } else {
    return null;
  }

  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hours > 23) return null;
  return toTime(hours * 60 + minutes);
}

export function formatHour(mins: number) {
  const date = new Date();
  date.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  // Show :MM only when non-zero so 3 PM stays compact but 3:30 PM
  // doesn't silently round to "3 PM". Previously every minute portion
  // was dropped, which made a 30-min event look like a 1-hour event
  // ("3 PM - 4 PM") that then rendered as a half-height block.
  return date.toLocaleTimeString("en-US", {
    timeZone: APP_TIME_ZONE,
    hour: "numeric",
    minute: mins % 60 === 0 ? undefined : "2-digit",
  });
}
