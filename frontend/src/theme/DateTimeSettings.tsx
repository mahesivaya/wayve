import { useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  getDateFormatPref,
  getTimeFormatPref,
  hourOptionsForTimeFormat,
  localeForDateFormat,
  setDateFormatPref,
  setTimeFormatPref,
  type DateFormatPref,
  type TimeFormatPref,
} from "../utils/datetime";
import "./themeCustomizer.css";

// A fixed moment, so each option's label and the example read the same for
// everyone: Feb 25, 2026, 2:30 PM in local time.
const SAMPLE = new Date(2026, 1, 25, 14, 30);

const systemLabel = () =>
  `System Default (${typeof navigator === "undefined" ? "browser" : navigator.language})`;

const formatDate = (pref: DateFormatPref) =>
  new Intl.DateTimeFormat(localeForDateFormat(pref), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(SAMPLE);

const formatTime = (pref: TimeFormatPref) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...hourOptionsForTimeFormat(pref),
  }).format(SAMPLE);

const DATE_PREFS: DateFormatPref[] = ["system", "month-first", "day-first"];
const TIME_PREFS: TimeFormatPref[] = ["system", "12h", "24h"];

// The Date & time card on the Appearance page. Each dropdown shows a live
// example of the format it picks.
export default function DateTimeSettings() {
  const { user } = useAuth();
  const [dateFormat, setDateFormat] = useState(getDateFormatPref);
  const [timeFormat, setTimeFormat] = useState(getTimeFormatPref);
  const exampleName = user?.email ?? "you@example.com";

  return (
    <section className="settings-card">
      <h2 className="settings-card-title">Date &amp; time</h2>

      <div className="datetime-row">
        <label htmlFor="date-format">Date Format</label>
        <div className="datetime-control">
          <select
            id="date-format"
            className="datetime-select"
            value={dateFormat}
            onChange={(e) => {
              const pref = e.target.value as DateFormatPref;
              setDateFormat(pref);
              setDateFormatPref(pref);
            }}
          >
            {DATE_PREFS.map((pref) => (
              <option key={pref} value={pref}>
                {pref === "system" ? systemLabel() : formatDate(pref)}
              </option>
            ))}
          </select>
          <div className="datetime-example-label">Example</div>
          <div className="datetime-example" data-testid="date-example">
            <span>{exampleName}</span>
            <strong>{formatDate(dateFormat)}</strong>
          </div>
        </div>
      </div>

      <div className="datetime-row">
        <label htmlFor="time-format">Time Format</label>
        <div className="datetime-control">
          <select
            id="time-format"
            className="datetime-select"
            value={timeFormat}
            onChange={(e) => {
              const pref = e.target.value as TimeFormatPref;
              setTimeFormat(pref);
              setTimeFormatPref(pref);
            }}
          >
            {TIME_PREFS.map((pref) => (
              <option key={pref} value={pref}>
                {pref === "system"
                  ? systemLabel()
                  : pref === "12h"
                    ? "12-hour (2:30 PM)"
                    : "24-hour (14:30)"}
              </option>
            ))}
          </select>
          <div className="datetime-example-label">Example</div>
          <div className="datetime-example" data-testid="time-example">
            <span>{exampleName}</span>
            <strong>{formatTime(timeFormat)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}
