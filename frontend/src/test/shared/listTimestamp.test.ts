// The inbox row timestamp. It must follow Gmail's rule — a clock time for
// today's mail, a date for anything earlier — so the same messages read the
// same in both. It used to show a time for anything in the last 24 hours, so
// yesterday evening's mail kept clock times that Gmail showed as dates.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fmtListTimestamp } from "../../utils/datetime";

// Local wall-clock dates, so the assertions hold in any test-runner time zone.
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi);

const timeOf = (d: Date) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

const dateOf = (d: Date, withYear = false) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(d);

describe("fmtListTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Late morning, like the screenshot that reported the mismatch.
    vi.setSystemTime(at(2026, 10, 26, 11, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the time for mail from earlier today", () => {
    const earlyToday = at(2026, 10, 26, 0, 5);
    expect(fmtListTimestamp(earlyToday)).toBe(timeOf(earlyToday));
  });

  it("shows the date for yesterday's mail, even within the last 24 hours", () => {
    // 12:35 PM yesterday is under 24 hours ago, but Gmail shows "Oct 25".
    const yesterdayAfternoon = at(2026, 10, 25, 12, 35);
    expect(fmtListTimestamp(yesterdayAfternoon)).toBe(
      dateOf(yesterdayAfternoon)
    );
    const lateLastNight = at(2026, 10, 25, 23, 59);
    expect(fmtListTimestamp(lateLastNight)).toBe(dateOf(lateLastNight));
  });

  it("adds the year only for mail from another year", () => {
    const lastYear = at(2025, 12, 31, 18, 0);
    expect(fmtListTimestamp(lastYear)).toBe(dateOf(lastYear, true));
  });

  it("accepts the API's ISO strings", () => {
    const today = at(2026, 10, 26, 9, 2);
    expect(fmtListTimestamp(today.toISOString())).toBe(timeOf(today));
  });
});
