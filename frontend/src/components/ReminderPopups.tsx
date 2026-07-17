import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { getReminders, type Reminder } from "../api/reminders";
import "./meetingReminders.css";

// Pop the reminder this many seconds before its remind time (~1 minute before).
const LEAD_MS = 60_000;
// Keep showing for a short grace window after the time passes, until dismissed.
const GRACE_MS = 2 * 60_000;
// How often to re-evaluate which reminders are due.
const TICK_MS = 20_000;
// How often to re-pull the reminder list so newly-created ones show up.
const REFRESH_MS = 2 * 60_000;

const DISMISS_KEY = "rwayve.reminderPopups.dismissed";
const SNOOZE_KEY = "rwayve.reminderPopups.snoozed";
const SNOOZE_OPTIONS = [5, 10, 30] as const;

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

export default function ReminderPopups() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [snoozed, setSnoozed] = useState<Record<string, number>>(loadSnoozed);
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setReminders(await getReminders());
    } catch {
      // Best-effort: keep the previous list on a failed pull.
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

  const due = useMemo(() => {
    if (userId === null) return [];
    return reminders
      .map((r) => ({ r, ts: new Date(r.remind_at).getTime() }))
      // From ~1 minute before the remind time until a short grace after.
      .filter(({ r, ts }) => {
        const delta = ts - now;
        if (delta > LEAD_MS || delta < -GRACE_MS) return false;
        const key = String(r.id);
        if (dismissed.has(key)) return false;
        const until = snoozed[key];
        return !(until && now < until);
      })
      .sort((a, b) => a.ts - b.ts)
      .map(({ r, ts }) => ({ ...r, ts }));
  }, [reminders, now, userId, dismissed, snoozed]);

  const dismiss = useCallback((id: number) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(String(id));
      saveDismissed(next);
      return next;
    });
  }, []);

  const snooze = useCallback((id: number, minutes: number) => {
    setSnoozed((prev) => {
      const next = { ...prev, [String(id)]: Date.now() + minutes * 60_000 };
      saveSnoozed(next);
      return next;
    });
    setSnoozeMenu(null);
  }, []);

  if (userId === null || due.length === 0) return null;

  return (
    <div
      className="meeting-reminders"
      role="region"
      aria-label="Reminder alerts"
    >
      {due.map((r) => {
        const key = String(r.id);
        const mins = Math.round((r.ts - now) / 60_000);
        const label = mins <= 0 ? "Now" : `In ${mins} min${mins === 1 ? "" : "s"}`;
        return (
          <div key={key} className="meeting-reminder-card" role="alert">
            <div className="meeting-reminder-head">
              <span className="meeting-reminder-icon" aria-hidden="true">
                ⏰
              </span>
              <span className="meeting-reminder-countdown">{label}</span>
              <button
                type="button"
                className="meeting-reminder-close"
                aria-label="Dismiss reminder"
                onClick={() => dismiss(r.id)}
              >
                ×
              </button>
            </div>

            <div className="meeting-reminder-title">{r.title}</div>
            {r.notes && (
              <div className="meeting-reminder-time">{r.notes}</div>
            )}

            <div className="meeting-reminder-actions">
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
                    {SNOOZE_OPTIONS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="menuitem"
                        className="meeting-reminder-snooze-item"
                        onClick={() => snooze(r.id, m)}
                      >
                        {m} min
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="meeting-reminder-open"
                onClick={() => dismiss(r.id)}
              >
                Done
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
