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

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Same shape as the call sites we're replacing: pass a string / number /
// Date and get back a localized string. `null` / invalid → an em-dash so
// every consumer can drop in without adding null guards.

export function fmtDateTime(input: string | number | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export function fmtDate(input: string | number | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function fmtShortDate(input: string | number | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

export function fmtTime(input: string | number | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export function fmtLongDate(input: string | number | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return FALLBACK;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}
