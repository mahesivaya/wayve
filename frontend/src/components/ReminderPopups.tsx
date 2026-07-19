import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { getReminders, type Reminder } from "../api/reminders";
import { getMeetings, type ApiMeeting } from "../api/scheduler";
import { fmtTime } from "../utils/datetime";
import { showDesktopNotification } from "./desktopNotifications";
import "./meetingReminders.css";

// Pop a standalone reminder this many seconds before its remind time. Meetings
// use the user's own lead time (users.meeting_alert_minutes) instead.
const LEAD_MS = 60_000;
// Keep showing for a short grace window after the time passes, until dismissed.
const GRACE_MS = 2 * 60_000;
// How often to re-evaluate which items are due.
const TICK_MS = 20_000;
// How often to re-pull the lists so newly-created entries show up.
const REFRESH_MS = 2 * 60_000;

// Mirrors the server default when /api/me predates meeting_alert_minutes.
const DEFAULT_MEETING_LEAD_MIN = 10;

const DISMISS_KEY = "rwayve.reminderPopups.dismissed";
const SNOOZE_KEY = "rwayve.reminderPopups.snoozed";
const NOTIFIED_KEY = "rwayve.reminderPopups.notified";
const SNOOZE_OPTIONS = [5, 10, 30] as const;

// Reminders and meetings are separate tables with independent id sequences, so
// every persisted key is namespaced by kind to keep reminder 7 and meeting 7
// from sharing a dismiss/snooze entry.
type AlertKind = "reminder" | "meeting";

type AlertItem = {
  key: string;
  kind: AlertKind;
  title: string;
  subtitle: string | null;
  // Epoch ms of the moment being alerted about.
  ts: number;
  // How far ahead of `ts` this item starts showing.
  lead: number;
  joinUrl: string | null;
};

function loadSet(storageKey: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveSet(storageKey: string, ids: Set<string>) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // Best-effort.
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
    // Best-effort.
  }
}

// Meetings store naive wall-clock ("YYYY-MM-DD" + "HH:MM[:SS]") with no zone, so
// they're resolved in the viewer's local zone — the same convention the
// scheduler renders with. Returns null for a row we can't parse rather than an
// Invalid Date that would silently never come due.
function wallClockMs(date: string, time: string) {
  if (!date || !time) return null;
  // Accept both "HH:MM" and "HH:MM:SS"; Safari is strict about the seconds.
  const t = time.length === 5 ? `${time}:00` : time;
  const ms = new Date(`${date}T${t}`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function meetingStartMs(m: Pick<ApiMeeting, "date" | "start_time">) {
  return wallClockMs(m.date, m.start_time);
}

// "2:30 PM – 3:00 PM", or just the start when the end is missing/unparseable.
function meetingSubtitle(m: ApiMeeting, startMs: number) {
  const endMs = wallClockMs(m.date, m.end_time);
  return endMs === null
    ? fmtTime(startMs)
    : `${fmtTime(startMs)} – ${fmtTime(endMs)}`;
}

export default function ReminderPopups() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const meetingLeadMin = user?.meeting_alert_minutes ?? DEFAULT_MEETING_LEAD_MIN;

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [meetings, setMeetings] = useState<ApiMeeting[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    loadSet(DISMISS_KEY)
  );
  // Which items have already raised an OS toast. A ref, not state: it never
  // affects what renders, and keeping it out of state avoids a setState inside
  // the notify effect (and the cascading render that comes with it).
  const notified = useRef<Set<string>>(loadSet(NOTIFIED_KEY));
  const [snoozed, setSnoozed] = useState<Record<string, number>>(loadSnoozed);
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);

  // Meetings are only pulled when alerts are on, so a user who set the lead
  // time to "Off" costs no extra request.
  const wantMeetings = meetingLeadMin > 0;

  const reload = useCallback(async () => {
    const [r, m] = await Promise.allSettled([
      getReminders(),
      wantMeetings ? getMeetings() : Promise.resolve<ApiMeeting[]>([]),
    ]);
    // Each list keeps its previous value on failure, so one endpoint being down
    // doesn't blank the other's popups.
    if (r.status === "fulfilled") setReminders(r.value);
    if (m.status === "fulfilled") setMeetings(Array.isArray(m.value) ? m.value : []);
  }, [wantMeetings]);

  useEffect(() => {
    if (userId === null) return;
    void reload();
    const refresh = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [userId, reload]);

  useEffect(() => {
    if (userId === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(tick);
  }, [userId]);

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

  const items = useMemo<AlertItem[]>(() => {
    const out: AlertItem[] = reminders.map((r) => ({
      key: `reminder:${r.id}`,
      kind: "reminder" as const,
      title: r.title,
      subtitle: r.notes,
      ts: new Date(r.remind_at).getTime(),
      lead: LEAD_MS,
      joinUrl: null,
    }));

    if (wantMeetings) {
      for (const m of meetings) {
        const ts = meetingStartMs(m);
        if (ts === null) continue;
        out.push({
          key: `meeting:${m.id}`,
          kind: "meeting",
          title: m.title,
          subtitle: meetingSubtitle(m, ts),
          ts,
          lead: meetingLeadMin * 60_000,
          joinUrl: m.zoom_join_url || null,
        });
      }
    }

    return out.filter((i) => !Number.isNaN(i.ts));
  }, [reminders, meetings, wantMeetings, meetingLeadMin]);

  const due = useMemo(() => {
    if (userId === null) return [];
    return items
      .filter((i) => {
        const delta = i.ts - now;
        if (delta > i.lead || delta < -GRACE_MS) return false;
        if (dismissed.has(i.key)) return false;
        const until = snoozed[i.key];
        return !(until && now < until);
      })
      .sort((a, b) => a.ts - b.ts);
  }, [items, now, userId, dismissed, snoozed]);

  // Raise an OS-level toast the first time each item comes due. Tracked in
  // sessionStorage so a reload mid-window doesn't re-notify for the same item.
  useEffect(() => {
    const fresh = due.filter((i) => !notified.current.has(i.key));
    if (fresh.length === 0) return;
    for (const i of fresh) {
      const mins = Math.round((i.ts - Date.now()) / 60_000);
      const when = mins <= 0 ? "now" : `in ${mins} min${mins === 1 ? "" : "s"}`;
      const raised = showDesktopNotification(
        i.kind === "meeting" ? `Meeting ${when}` : `Reminder ${when}`,
        i.subtitle ? `${i.title} · ${i.subtitle}` : i.title,
        i.key
      );
      // Only a toast that actually appeared counts as notified. Recording a
      // no-op would permanently skip an item that's still on screen when the
      // user grants permission or switches desktop notifications on.
      if (raised) notified.current.add(i.key);
    }
    saveSet(NOTIFIED_KEY, notified.current);
  }, [due]);

  const dismiss = useCallback((key: string) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(key);
      saveSet(DISMISS_KEY, next);
      return next;
    });
  }, []);

  const snooze = useCallback((key: string, minutes: number) => {
    setSnoozed((prev) => {
      const next = { ...prev, [key]: Date.now() + minutes * 60_000 };
      saveSnoozed(next);
      return next;
    });
    // Let the snoozed item notify again when it re-surfaces.
    notified.current.delete(key);
    saveSet(NOTIFIED_KEY, notified.current);
    setSnoozeMenu(null);
  }, []);

  if (userId === null || due.length === 0) return null;

  return (
    <div
      className="meeting-reminders"
      role="region"
      aria-label="Reminder alerts"
    >
      {due.map((item) => {
        const mins = Math.round((item.ts - now) / 60_000);
        const label = mins <= 0 ? "Now" : `In ${mins} min${mins === 1 ? "" : "s"}`;
        return (
          <div key={item.key} className="meeting-reminder-card" role="alert">
            <div className="meeting-reminder-head">
              <span className="meeting-reminder-icon" aria-hidden="true">
                {item.kind === "meeting" ? "📅" : "⏰"}
              </span>
              <span className="meeting-reminder-countdown">{label}</span>
              <button
                type="button"
                className="meeting-reminder-close"
                aria-label={
                  item.kind === "meeting"
                    ? "Dismiss meeting alert"
                    : "Dismiss reminder"
                }
                onClick={() => dismiss(item.key)}
              >
                ×
              </button>
            </div>

            <div className="meeting-reminder-title">{item.title}</div>
            {item.subtitle && (
              <div className="meeting-reminder-time">{item.subtitle}</div>
            )}

            <div className="meeting-reminder-actions">
              <div className="meeting-reminder-snooze">
                <button
                  type="button"
                  className="meeting-reminder-open"
                  aria-haspopup="menu"
                  aria-expanded={snoozeMenu === item.key}
                  onClick={() =>
                    setSnoozeMenu((cur) => (cur === item.key ? null : item.key))
                  }
                >
                  Snooze ▾
                </button>
                {snoozeMenu === item.key && (
                  <div className="meeting-reminder-snooze-menu" role="menu">
                    {SNOOZE_OPTIONS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="menuitem"
                        className="meeting-reminder-snooze-item"
                        onClick={() => snooze(item.key, m)}
                      >
                        {m} min
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {item.joinUrl ? (
                <a
                  className="meeting-reminder-join"
                  href={item.joinUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={() => dismiss(item.key)}
                >
                  Join
                </a>
              ) : (
                <button
                  type="button"
                  className="meeting-reminder-open"
                  onClick={() => dismiss(item.key)}
                >
                  Done
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
