// Settings › Appearance › Date & time: the two dropdowns show a live example
// and change how the app's shared formatters print dates and times.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@test.local" } }),
}));

import DateTimeSettings from "../../theme/DateTimeSettings";
import {
  fmtDate,
  fmtDateTime,
  fmtTime,
  getDateFormatPref,
  setDateFormatPref,
  setTimeFormatPref,
} from "../../utils/datetime";

const AT = new Date(2026, 1, 25, 14, 30);
const norm = (text: string | null | undefined) =>
  (text ?? "").replace(/\s/g, " ");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("the shared formatters", () => {
  it("put the day first or the month first", () => {
    setDateFormatPref("day-first");
    expect(fmtDate(AT)).toBe("25 Feb 2026");
    setDateFormatPref("month-first");
    expect(fmtDate(AT)).toBe("Feb 25, 2026");
  });

  it("print 12-hour or 24-hour times", () => {
    setTimeFormatPref("24h");
    expect(fmtTime(AT)).toBe("14:30");
    expect(fmtDateTime(AT)).toContain("14:30");
    setTimeFormatPref("12h");
    expect(norm(fmtTime(AT))).toBe("2:30 PM");
  });

  it("prints midnight as 00, not 24, in 24-hour time", () => {
    setTimeFormatPref("24h");
    expect(fmtTime(new Date(2026, 1, 25, 0, 5))).toMatch(/^0?0:05$/);
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem("wayve-date-format", "nonsense");
    expect(getDateFormatPref()).toBe("system");
  });
});

describe("the Date & time card", () => {
  it("updates the example and saves the pick", async () => {
    render(<DateTimeSettings />);

    await userEvent.selectOptions(
      screen.getByLabelText("Date Format"),
      "day-first"
    );
    expect(screen.getByTestId("date-example").textContent).toContain(
      "25 Feb 2026"
    );
    expect(getDateFormatPref()).toBe("day-first");
    expect(fmtDate(AT)).toBe("25 Feb 2026");

    await userEvent.selectOptions(screen.getByLabelText("Time Format"), "24h");
    expect(screen.getByTestId("time-example").textContent).toContain("14:30");
  });

  it("starts on the browser's own format", () => {
    render(<DateTimeSettings />);

    expect(
      (screen.getByLabelText("Date Format") as HTMLSelectElement).value
    ).toBe("system");
    expect(screen.getAllByText(/^System Default \(/).length).toBe(2);
  });
});
