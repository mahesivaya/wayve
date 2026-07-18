import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getMeetings } from "../api/scheduler";
import { getTasks, type Task, type TaskPriority } from "../api/tasks";
import {
  getReminders,
  createReminder,
  deleteReminder,
  type Reminder,
} from "../api/reminders";
import { fromTime, formatHour } from "../scheduler/dateUtils";
import "./reminders.css";

type ApiMeeting = {
  id: number;
  title: string;
  date: string;
  start_time: string;
  end_time?: string | null;
  zoom_join_url?: string | null;
};

type UpcomingMeeting = {
  id: number;
  title: string;
  date: string;
  startMin: number;
  endMin: number;
  zoomUrl: string | null;
  startTs: number;
};

const priorityLabel = (p: TaskPriority): string =>
  p === 5
    ? "Highest"
    : p === 4
      ? "High"
      : p === 3
        ? "Medium"
        : p === 2
          ? "Low"
          : "Lowest";

const statusLabel = (s: Task["status"]): string =>
  s === "in_progress"
    ? "In Progress"
    : s === "in_review"
      ? "In Review"
      : s === "done"
        ? "Done"
        : "To Do";

// A local Date for a meeting's date ("YYYY-MM-DD") + minute-of-day. Meetings are
// stored/validated in the browser's local zone, so a plain local Date matches.
function localTs(date: string, minuteOfDay: number): number {
  const [y, mo, d] = date.split("-").map(Number);
  const dt = new Date(y, (mo ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  dt.setMinutes(minuteOfDay);
  return dt.getTime();
}

// Human "in 8 mins" / "in 2 hrs" / "tomorrow" / weekday for a future timestamp.
function relativeWhen(ts: number, now: number): string {
  const mins = Math.round((ts - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min${mins === 1 ? "" : "s"}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 12) return `in ${hrs} hr${hrs === 1 ? "" : "s"}`;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.round((ts - start.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) {
    return new Date(ts).toLocaleDateString("en-US", { weekday: "long" });
  }
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const dateLabel = (date: string): string =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

export default function Reminders() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const now = Date.now();

  // Create-form state.
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadReminders = useCallback(async () => {
    try {
      setReminders(await getReminders());
    } catch {
      // Best-effort: leave the previous list on a failed pull.
    }
  }, []);

  const load = useCallback(async () => {
    const [meetingsRes, tasksRes] = await Promise.allSettled([
      getMeetings() as Promise<ApiMeeting[]>,
      getTasks(),
    ]);
    if (meetingsRes.status === "fulfilled") {
      setMeetings(
        meetingsRes.value.map((m) => {
          const startMin = fromTime(m.start_time);
          const endMin = m.end_time ? fromTime(m.end_time) : startMin;
          return {
            id: m.id,
            title: m.title,
            date: m.date,
            startMin,
            endMin,
            zoomUrl: m.zoom_join_url ?? null,
            startTs: localTs(m.date, startMin),
          };
        })
      );
    }
    if (tasksRes.status === "fulfilled") setTasks(tasksRes.value);
    await loadReminders();
    setLoading(false);
  }, [loadReminders]);

  useEffect(() => {
    void load();
  }, [load]);

  const addReminder = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError("Give the reminder a title.");
      return;
    }
    if (!remindAt) {
      setFormError("Pick a date and time.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createReminder({
        title: trimmed,
        remind_at: remindAt,
        notes: note.trim() || null,
      });
      setTitle("");
      setRemindAt("");
      setNote("");
      await loadReminders();
    } catch {
      setFormError("Couldn't save the reminder. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const removeReminder = async (id: number) => {
    // Optimistic: drop it locally, then reconcile with the server.
    setReminders((prev) => prev.filter((r) => r.id !== id));
    try {
      await deleteReminder(id);
    } catch {
      await loadReminders();
    }
  };

  // Upcoming = hasn't ended yet, soonest first.
  const upcomingMeetings = useMemo(() => {
    return meetings
      .filter((m) => localTs(m.date, m.endMin) >= now)
      .sort((a, b) => a.startTs - b.startTs);
  }, [meetings, now]);

  // Tasks have no due date, so "nearest" can't apply — order by priority
  // (Highest first) then most-recently created.
  const openTasks = useMemo(() => {
    return tasks
      .filter((t) => t.status !== "done")
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const at = new Date(a.created_at ?? 0).getTime();
        const bt = new Date(b.created_at ?? 0).getTime();
        return bt - at;
      });
  }, [tasks]);

  // Reminders soonest-first by their remind time.
  const sortedReminders = useMemo(() => {
    return [...reminders].sort(
      (a, b) =>
        new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime()
    );
  }, [reminders]);

  return (
    <div className="reminders-page">
      <header className="reminders-header">
        <h1>🔔 Reminders</h1>
        <p className="reminders-subtitle">
          Your reminders, upcoming meetings, and open tasks — soonest first.
        </p>
      </header>

      <div className="reminders-layout">
        <div className="reminders-side-col">
      <section className="reminders-section">
        <div className="reminders-section-head">
          <h2>New reminder</h2>
        </div>
        <form
          className="reminder-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addReminder();
          }}
        >
          <div className="reminder-form-row">
            <input
              className="reminder-form-title"
              type="text"
              placeholder="Remind me to…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Reminder title"
            />
            <input
              className="reminder-form-time"
              type="datetime-local"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
              aria-label="Remind at"
            />
          </div>
          <textarea
            className="reminder-form-note"
            placeholder="Notes (optional)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Reminder notes"
          />
          {formError && <div className="reminder-form-error">{formError}</div>}
          <div className="reminder-form-actions">
            <button type="submit" className="reminder-form-submit" disabled={saving}>
              {saving ? "Adding…" : "Add reminder"}
            </button>
          </div>
        </form>
      </section>
        </div>

        <div className="reminders-main-col">
      <section className="reminders-section">
        <div className="reminders-section-head">
          <h2>Your reminders</h2>
          <span className="reminders-count">{sortedReminders.length}</span>
        </div>
        {loading ? (
          <div className="reminders-empty">Loading…</div>
        ) : sortedReminders.length === 0 ? (
          <div className="reminders-empty">
            No reminders yet — add one above.
          </div>
        ) : (
          <ul className="reminders-list">
            {sortedReminders.map((r) => {
              const ts = new Date(r.remind_at).getTime();
              return (
                <li key={r.id} className="reminder-row reminder-row--static">
                  <span className="reminder-when">
                    {ts >= now ? relativeWhen(ts, now) : "past"}
                  </span>
                  <span className="reminder-main">
                    <span className="reminder-title">{r.title}</span>
                    <span className="reminder-meta">
                      {new Date(r.remind_at).toLocaleString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {r.notes ? ` · ${r.notes}` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="reminder-delete"
                    aria-label="Delete reminder"
                    onClick={() => void removeReminder(r.id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="reminders-section">
        <div className="reminders-section-head">
          <h2>Upcoming meetings</h2>
          <span className="reminders-count">{upcomingMeetings.length}</span>
        </div>
        {loading ? (
          <div className="reminders-empty">Loading…</div>
        ) : upcomingMeetings.length === 0 ? (
          <div className="reminders-empty">No upcoming meetings.</div>
        ) : (
          <ul className="reminders-list">
            {upcomingMeetings.map((m) => (
              <li
                key={`${m.id}:${m.date}`}
                className="reminder-row"
                onClick={() => navigate("/scheduler")}
              >
                <span className="reminder-when">{relativeWhen(m.startTs, now)}</span>
                <span className="reminder-main">
                  <span className="reminder-title">{m.title || "Meeting"}</span>
                  <span className="reminder-meta">
                    {dateLabel(m.date)} · {formatHour(m.startMin)} –{" "}
                    {formatHour(m.endMin)}
                  </span>
                </span>
                {m.zoomUrl && (
                  <a
                    className="reminder-join"
                    href={m.zoomUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Join
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="reminders-section">
        <div className="reminders-section-head">
          <h2>Open tasks</h2>
          <span className="reminders-count">{openTasks.length}</span>
        </div>
        {loading ? (
          <div className="reminders-empty">Loading…</div>
        ) : openTasks.length === 0 ? (
          <div className="reminders-empty">No open tasks.</div>
        ) : (
          <ul className="reminders-list">
            {openTasks.map((t) => (
              <li
                key={t.id}
                className="reminder-row"
                onClick={() => navigate("/tasks")}
              >
                <span
                  className={`reminder-priority p${t.priority}`}
                  data-tooltip={`Priority ${t.priority} — ${priorityLabel(t.priority)}`}
                >
                  P{t.priority}
                </span>
                <span className="reminder-main">
                  <span className="reminder-title">{t.name}</span>
                  <span className="reminder-meta">
                    {priorityLabel(t.priority)} · {statusLabel(t.status)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
        </div>
      </div>
    </div>
  );
}
