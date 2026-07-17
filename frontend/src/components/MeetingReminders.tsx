import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { getMeetings } from "../api/scheduler";
import { fromTime, formatHour } from "../scheduler/dateUtils";
import "./meetingReminders.css";

// Fire the reminder this many minutes before a meeting's start time.
const LEAD_MINUTES = 15;
// How often to re-evaluate which meetings are due (ms).
const TICK_MS = 30_000;
// How often to re-pull the meeting list so freshly-created meetings show up.
const REFRESH_MS = 5 * 60_000;

// Dismissals persist for the session so a reminder that was closed doesn't
// re-pop on the next tick (or a route change — Layout keeps this mounted). The
// key is scoped by meeting id + date so the same recurring slot can remind
// again another day.
const DISMISS_KEY = "rwayve.meetingReminders.dismissed";
// Snoozes: key → epoch-ms until which the reminder stays hidden. Persisted so a
// route change doesn't cancel the snooze.
const SNOOZE_KEY = "rwayve.meetingReminders.snoozed";

// Minutes offered in the snooze dropdown.
const SNOOZE_OPTIONS = [5, 10, 30] as const;

type ApiMeeting = {
  id: number;
  title: string;
  date: string;
  start_time: string;
  zoom_join_url?: string | null;
};

type UpcomingMeeting = {
  id: number;
  title: string;
  date: string;
  startMin: number;
  zoomUrl: string | null;
};

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort; a full private-mode block just means reminders may re-show.
  }
}

function loadSnoozed(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(SNOOZE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSnoozed(map: Record<string, number>) {
  try {
    sessionStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort; a private-mode block just means snoozes don't survive nav.
  }
}

// Minutes from `now` until the meeting starts. Times are stored in the
// browser's local zone (the scheduler validates against local now), so a plain
// local Date reconstruction matches how meetings were created.
function minutesUntilStart(m: UpcomingMeeting, now: Date): number {
  const [y, mo, d] = m.date.split("-").map(Number);
  const start = new Date(y, (mo ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  start.setMinutes(m.startMin);
  return Math.round((start.getTime() - now.getTime()) / 60_000);
}

export default function MeetingReminders() {
  const { user } = useAuth();
  // Depend on the id, not the `user` object: some auth providers hand back a
  // fresh object each render, and keying effects on that would re-arm the
  // intervals (and re-fetch) every render.
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [snoozed, setSnoozed] = useState<Record<string, number>>(loadSnoozed);
  // Key of the card whose snooze menu is open (only one open at a time).
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = (await getMeetings()) as ApiMeeting[];
      setMeetings(
        data.map((m) => ({
          id: m.id,
          title: m.title,
          date: m.date,
          startMin: fromTime(m.start_time),
          zoomUrl: m.zoom_join_url ?? null,
        }))
      );
    } catch {
      // Best-effort: a failed pull just keeps the previous list.
    }
  }, []);

  useEffect(() => {
    if (userId === null) return;
    void reload();
    const refresh = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [userId, reload]);

  useEffect(() => {
    if (userId === null) return;
    const tick = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(tick);
  }, [userId]);

  // Close the snooze dropdown on any click outside a snooze control.
  useEffect(() => {
    if (snoozeMenu === null) return;
    const onDown = (e: MouseEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest(".meeting-reminder-snooze")
      ) {
        return;
      }
      setSnoozeMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [snoozeMenu]);

  const due = useMemo(() => {
    if (userId === null) return [];
    return meetings
      .map((m) => ({ m, mins: minutesUntilStart(m, now) }))
      // In the window [start - LEAD, start): still upcoming, ≤ 15 min away.
      .filter(({ m, mins }) => {
        if (mins < 0 || mins > LEAD_MINUTES) return false;
        const key = `${m.id}:${m.date}`;
        if (dismissed.has(key)) return false;
        const until = snoozed[key];
        return !(until && now.getTime() < until);
      })
      .sort((a, b) => a.mins - b.mins)
      .map(({ m, mins }) => ({ ...m, mins }));
  }, [meetings, now, userId, dismissed, snoozed]);

  const dismiss = useCallback((m: UpcomingMeeting) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(`${m.id}:${m.date}`);
      saveDismissed(next);
      return next;
    });
  }, []);

  const snooze = useCallback((m: UpcomingMeeting, minutes: number) => {
    const key = `${m.id}:${m.date}`;
    setSnoozed((prev) => {
      const next = { ...prev, [key]: Date.now() + minutes * 60_000 };
      saveSnoozed(next);
      return next;
    });
    setSnoozeMenu(null);
  }, []);

  if (userId === null || due.length === 0) return null;

  return (
    <div className="meeting-reminders" role="region" aria-label="Meeting reminders">
      {due.map((m) => {
        const key = `${m.id}:${m.date}`;
        const label =
          m.mins <= 0
            ? "Starting now"
            : `In ${m.mins} min${m.mins === 1 ? "" : "s"}`;
        return (
          <div key={key} className="meeting-reminder-card" role="alert">
            <div className="meeting-reminder-head">
              <span className="meeting-reminder-icon" aria-hidden="true">
                🔔
              </span>
              <span className="meeting-reminder-countdown">{label}</span>
              <button
                type="button"
                className="meeting-reminder-close"
                aria-label="Dismiss reminder"
                onClick={() => dismiss(m)}
              >
                ×
              </button>
            </div>

            <div className="meeting-reminder-title">{m.title || "Meeting"}</div>
            <div className="meeting-reminder-time">
              Starts at {formatHour(m.startMin)}
            </div>

            <div className="meeting-reminder-actions">
              {m.zoomUrl && (
                <a
                  className="meeting-reminder-join"
                  href={m.zoomUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => dismiss(m)}
                >
                  Join
                </a>
              )}

              <div className="meeting-reminder-snooze">
                <button
                  type="button"
                  className="meeting-reminder-open"
                  aria-haspopup="menu"
                  aria-expanded={snoozeMenu === key}
                  onClick={() =>
                    setSnoozeMenu((cur) => (cur === key ? null : key))
                  }
                >
                  Snooze ▾
                </button>
                {snoozeMenu === key && (
                  <div className="meeting-reminder-snooze-menu" role="menu">
                    {SNOOZE_OPTIONS.map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        role="menuitem"
                        className="meeting-reminder-snooze-item"
                        onClick={() => snooze(m, mins)}
                      >
                        {mins} min
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="meeting-reminder-open"
                onClick={() => {
                  dismiss(m);
                  void navigate("/scheduler");
                }}
              >
                Open calendar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
