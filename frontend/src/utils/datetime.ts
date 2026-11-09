// Project-wide datetime formatting. Every displayed timestamp routes
// through one of these helpers so the whole app uses one consistent
// format — but the **visitor's local timezone** is preserved: a user
// in IST sees IST, a user in EST sees EST, a user in JST sees JST.
//
// Storage stays UTC server-side; this module is presentation only.
// Don't pass an explicit `timeZone` to `Intl.DateTimeFormat` — the
// default already resolves to the browser's local zone, which is
// exactly what we want.
//
// `APP_TIME_ZONE` is exported as `undefined` so that legacy call
// sites that imported the constant don't break — they pass it into
// the `timeZone` option, which Intl treats as "use the browser
// default" when undefined.

export const APP_TIME_ZONE: string | undefined = undefined;

const FALLBACK = "—";

// The user's date and time format, from Settings › Appearance. Stored per
// browser. "system" follows the browser's own locale.
export type DateFormatPref = "system" | "month-first" | "day-first";
export type TimeFormatPref = "system" | "12h" | "24h";

const DATE_FORMAT_KEY = "wayve-date-format";
const TIME_FORMAT_KEY = "wayve-time-format";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* per-browser convenience only */
  }
}

export function getDateFormatPref(): DateFormatPref {
  const value = readPref(DATE_FORMAT_KEY);
  return value === "month-first" || value === "day-first" ? value : "system";
}

export function getTimeFormatPref(): TimeFormatPref {
  const value = readPref(TIME_FORMAT_KEY);
  return value === "12h" || value === "24h" ? value : "system";
}

export const setDateFormatPref = (pref: DateFormatPref) =>
  writePref(DATE_FORMAT_KEY, pref);
export const setTimeFormatPref = (pref: TimeFormatPref) =>
  writePref(TIME_FORMAT_KEY, pref);

// The locale that gives a date format: month first or day first.
export function localeForDateFormat(pref: DateFormatPref): string | undefined {
  if (pref === "month-first") return "en-US";
  if (pref === "day-first") return "en-GB";
  return undefined;
}

// Intl options for a time format. hourCycle, because `hour12: false` can print
// midnight as 24:00.
export function hourOptionsForTimeFormat(
  pref: TimeFormatPref
): Pick<Intl.DateTimeFormatOptions, "hourCycle"> {
  if (pref === "12h") return { hourCycle: "h12" };
  if (pref === "24h") return { hourCycle: "h23" };
  return {};
}

// The current preference, for call sites that format dates themselves.
export const displayLocale = () => localeForDateFormat(getDateFormatPref());
export const hourOptions = () => hourOptionsForTimeFormat(getTimeFormatPref());

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Same shape as the call sites we're replacing: pass a string / number /
// Date and get back a localized string. `null` / invalid → an em-dash so
// every consumer can drop in without adding null guards.

export function fmtDateTime(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(displayLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...hourOptions(),
  }).format(d);
}

export function fmtDate(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(displayLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function fmtShortDate(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(displayLocale(), {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

export function fmtTime(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...hourOptions(),
  }).format(d);
}

// Inbox-row timestamp: show the time (e.g. "7:48 PM") for messages from today,
// and a short date for anything earlier (e.g. "Jun 3", or "Jun 3, 2024" when
// the year differs from now). "Today" is the viewer's local calendar day, as
// in Gmail — not the last 24 hours, which kept yesterday evening's mail on
// clock times and made the list disagree with Gmail's for the same messages.
export function fmtListTimestamp(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...hourOptions(),
    }).format(d);
  }
  return new Intl.DateTimeFormat(displayLocale(), {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(d);
}

export function fmtLongDate(
  input: string | number | Date | null | undefined
): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(displayLocale(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}
