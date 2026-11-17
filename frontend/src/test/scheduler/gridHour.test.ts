// The hour labels down the side of the calendar follow the time format from
// Settings > Appearance: AM/PM on a 12-hour clock, HH:MM on a 24-hour one.
import { afterEach, describe, expect, it } from "vitest";
import { formatGridHour, uses12HourClock } from "../../scheduler/dateUtils";
import { setTimeFormatPref } from "../../utils/datetime";

// Intl puts a narrow no-break space before AM/PM in some runtimes.
const plain = (label: string) => label.replace(/\s/g, " ");

describe("calendar hour labels", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("shows AM and PM on a 12-hour clock", () => {
    setTimeFormatPref("12h");
    expect(uses12HourClock()).toBe(true);
    expect(plain(formatGridHour(0))).toBe("12 AM");
    expect(plain(formatGridHour(9 * 60))).toBe("9 AM");
    expect(plain(formatGridHour(12 * 60))).toBe("12 PM");
    expect(plain(formatGridHour(13 * 60 + 30))).toBe("1:30 PM");
    expect(plain(formatGridHour(23 * 60))).toBe("11 PM");
  });

  it("keeps HH:MM on a 24-hour clock", () => {
    setTimeFormatPref("24h");
    expect(uses12HourClock()).toBe(false);
    expect(formatGridHour(0)).toBe("00:00");
    expect(formatGridHour(13 * 60 + 30)).toBe("13:30");
  });
});
