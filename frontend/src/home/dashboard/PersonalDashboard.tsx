import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import {
  getHomeToday,
  getHomeTasks,
  type MeetingPreview,
  type TaskPreview,
} from "../../api/home";
import { getEmails, markEmailRead } from "../../api/email";

// Persists the ids of emails we've just opened from this card so the
// next mount of the home page applies the read state immediately,
// even before /api/emails has caught up with the backend write. The
// set is bounded so it can't grow without limit; entries are dropped
// once they get crowded out.
const RECENT_READ_KEY = "rwayve.home.recentlyRead";
const RECENT_READ_MAX = 200;

function loadRecentlyRead(): Set<number> {
  try {
    const raw = sessionStorage.getItem(RECENT_READ_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is number => typeof v === "number"));
  } catch {
    return new Set();
  }
}

function markRecentlyRead(id: number) {
  try {
    const current = loadRecentlyRead();
    current.add(id);
    // Bound the set — drop oldest entries when capacity is hit.
    const arr = Array.from(current);
    const trimmed = arr.slice(Math.max(0, arr.length - RECENT_READ_MAX));
    sessionStorage.setItem(RECENT_READ_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore — private mode / quota
  }
}
import { updateTaskApi } from "../../api/tasks";
import type { EmailItem } from "../../emails/types";
import { APP_TIME_ZONE } from "../../utils/datetime";
import "./personalDashboard.css";

// Three-section personal-user home: welcome strip + Today (meetings +
// tasks merged) + a tall scrollable Emails list. Org / platform-admin
// users get the per-card 2×2 ActivityDashboard instead; this layout is
// shaped around how an individual moves through their day (look at
// what's next → triage email).

const formatHHMM = (hhmm: string) => {
  const parts = hhmm.split(":").map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const period = h >= 12 ? "PM" : "AM";
  const display = ((h + 11) % 12) + 1;
  return `${display}:${String(m).padStart(2, "0")} ${period}`;
};

const formatRelative = (iso: string | null | undefined) => {
  if (!iso) return "";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

const senderName = (sender: string | null | undefined) => {
  if (!sender) return "Unknown";
  const match = sender.match(/^"?([^"<]+?)"?\s*<.*>$/);
  if (match) return match[1].trim();
  if (sender.includes("@")) return sender.split("@")[0];
  return sender;
};

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

const todayLabel = () =>
  new Date().toLocaleDateString("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

export default function PersonalDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const firstName = user?.email?.split("@")[0] ?? "there";

  const [meetings, setMeetings] = useState<MeetingPreview[] | null>(null);
  const [tasks, setTasks] = useState<TaskPreview[] | null>(null);
  const [emails, setEmails] = useState<EmailItem[] | null>(null);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [meetingsErr, setMeetingsErr] = useState<string | null>(null);
  const [tasksErr, setTasksErr] = useState<string | null>(null);
  const [emailsErr, setEmailsErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getHomeToday()
      .then((data) => {
        if (!cancelled) setMeetings(data.events);
      })
      .catch((err) => {
        if (!cancelled) {
          setMeetingsErr(err instanceof Error ? err.message : "Failed to load");
          setMeetings([]);
        }
      });

    getHomeTasks()
      .then((data) => {
        if (!cancelled) setTasks(data.top);
      })
      .catch((err) => {
        if (!cancelled) {
          setTasksErr(err instanceof Error ? err.message : "Failed to load");
          setTasks([]);
        }
      });

    getEmails<EmailItem>({ folder: "inbox" })
      .then((result) => {
        if (cancelled) return;
        // Apply the "recently opened from this card" hint so emails the
        // user just clicked render as read immediately — even if the
        // backend write hasn't completed yet by the time we re-fetched.
        const recent = loadRecentlyRead();
        const merged = recent.size === 0
          ? result.emails
          : result.emails.map((email) =>
              recent.has(email.id) && email.is_read === false
                ? { ...email, is_read: true }
                : email,
            );
        setEmails(merged);
        // Lower-bound unread count from the loaded page.
        setUnreadCount(merged.filter((e) => !e.is_read).length);
      })
      .catch((err) => {
        if (!cancelled) {
          setEmailsErr(err instanceof Error ? err.message : "Failed to load");
          setEmails([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Inline complete: optimistic flip, then PUT. Rolls back on failure.
  const completeTask = useCallback(
    async (task: TaskPreview) => {
      const previous = tasks;
      setTasks((prev) =>
        (prev ?? []).filter((t) => t.id !== task.id),
      );
      try {
        await updateTaskApi(task.id, {
          name: task.name,
          description: "",
          priority: 3,
          status: "done",
        });
      } catch (err) {
        setTasks(previous);
        window.alert(
          err instanceof Error ? err.message : "Failed to complete task",
        );
      }
    },
    [tasks],
  );

  // Click handler for the Inbox card: mark the email read optimistically
  // both in the visible list AND in sessionStorage (so a fast back-nav
  // from /emails to /home still sees the row as read), then fire the
  // markEmailRead POST in the background, then navigate. The /emails
  // page's openEmail no-ops the markEmailRead call when it sees the
  // row already at is_read=true, so this isn't double work.
  const openEmailFromHome = (email: EmailItem) => {
    if (email.is_read === false) {
      markRecentlyRead(email.id);
      setEmails((prev) =>
        prev
          ? prev.map((row) =>
              row.id === email.id ? { ...row, is_read: true } : row,
            )
          : prev,
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      void markEmailRead(email.id).catch(() => {
        // Best-effort — useEmailInbox.openEmail will retry the POST
        // once the /emails page picks up the deep link.
      });
    }
    void navigate(`/emails?open=${email.id}`);
  };

  const meetingsLoading = meetings === null;
  const tasksLoading = tasks === null;
  const emailsLoading = emails === null;

  const totalsLabel = [
    meetings
      ? `${meetings.length} meeting${meetings.length === 1 ? "" : "s"}`
      : null,
    tasks ? `${tasks.length} open task${tasks.length === 1 ? "" : "s"}` : null,
    emails
      ? `${unreadCount.toLocaleString()} unread email${unreadCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="personal-dashboard">
      {/* ── 1. Welcome strip ───────────────────────────────────── */}
      <section className="personal-dashboard-greeting">
        <h1>
          {greeting()}, <span>{firstName}</span>
        </h1>
        <p>
          {todayLabel()}
          {totalsLabel ? ` · ${totalsLabel}` : ""}
        </p>
      </section>

      {/* ── 2. Meetings ────────────────────────────────────────── */}
      <section className="personal-card">
        <header className="personal-card-head">
          <h2>Meetings</h2>
          <button
            type="button"
            className="personal-card-action"
            onClick={() => navigate("/scheduler")}
          >
            Open scheduler →
          </button>
        </header>

        {meetingsLoading ? (
          <div className="personal-card-skeleton">
            <span /> <span />
          </div>
        ) : (meetings?.length ?? 0) === 0 ? (
          <p className="personal-card-empty">No meetings scheduled today.</p>
        ) : (
          <ul className="personal-today-list">
            {(meetings ?? []).map((m) => (
              <li
                key={`m-${m.id}`}
                className="personal-today-row is-meeting"
                onClick={() => navigate("/scheduler")}
              >
                <span className="personal-today-marker" aria-hidden="true">
                  ●
                </span>
                <span className="personal-today-time">
                  {formatHHMM(m.start_time)}
                </span>
                <span className="personal-today-title">{m.title}</span>
                <span className="personal-today-meta">
                  {m.participants_count > 0
                    ? `${m.participants_count} ppl`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}

        {meetingsErr && (
          <div className="personal-card-error">{meetingsErr}</div>
        )}
      </section>

      {/* ── 3. Task ────────────────────────────────────────────── */}
      <section className="personal-card">
        <header className="personal-card-head">
          <h2>Task</h2>
          <button
            type="button"
            className="personal-card-action"
            onClick={() => navigate("/tasks")}
          >
            + Add task
          </button>
        </header>

        {tasksLoading ? (
          <div className="personal-card-skeleton">
            <span /> <span /> <span />
          </div>
        ) : (tasks?.length ?? 0) === 0 ? (
          <p className="personal-card-empty">
            Nothing on your plate. Quiet day ahead.
          </p>
        ) : (
          <ul className="personal-today-list">
            {(tasks ?? []).map((t) => (
              <li
                key={`t-${t.id}`}
                className="personal-today-row is-task"
                onClick={() => navigate("/tasks")}
              >
                <button
                  type="button"
                  className="personal-today-check"
                  onClick={(e) => {
                    e.stopPropagation();
                    void completeTask(t);
                  }}
                  title="Mark done"
                  aria-label="Mark done"
                >
                  ○
                </button>
                <span className="personal-today-time">Task</span>
                <span className="personal-today-title">{t.name}</span>
                <span className="personal-today-meta">
                  {t.status.replace("_", " ")}
                </span>
              </li>
            ))}
          </ul>
        )}

        {tasksErr && <div className="personal-card-error">{tasksErr}</div>}
      </section>

      {/* ── 3. Emails ──────────────────────────────────────────── */}
      <section className="personal-card personal-emails-card">
        <header className="personal-card-head">
          <h2>Emails</h2>
          <button
            type="button"
            className="personal-card-action"
            onClick={() => navigate("/emails")}
          >
            Open inbox →
          </button>
        </header>

        {emailsLoading ? (
          <div className="personal-card-skeleton">
            <span /> <span /> <span /> <span /> <span />
          </div>
        ) : (emails?.length ?? 0) === 0 ? (
          <p className="personal-card-empty">
            No emails yet. Connect an account to get started.
          </p>
        ) : (
          <ul className="personal-emails-list">
            {(emails ?? []).map((email) => (
              <li
                key={email.id}
                className={`personal-email-row ${email.is_read ? "is-read" : "is-unread"}`}
                onClick={() => openEmailFromHome(email)}
              >
                <span className="personal-email-dot" aria-hidden="true" />
                <span className="personal-email-icon" aria-hidden="true">
                  {/* Mirror the /emails inbox: closed envelope for
                      unread, opened envelope for read. Inline SVG so
                      the glyph looks the same on every OS. */}
                  {email.is_read === false ? (
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="1.75" y="3.5" width="12.5" height="9" rx="1.5" />
                      <path d="M2 4.5l6 4.5 6-4.5" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14.5 7v5.75a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V7a1.5 1.5 0 0 1 .6-1.2l5.25-3.95a1.5 1.5 0 0 1 1.8 0l5.25 3.95A1.5 1.5 0 0 1 14.5 7Z" />
                      <path d="M14.25 7.25L8 11.5 1.75 7.25" />
                    </svg>
                  )}
                </span>
                <span className="personal-email-sender">
                  {senderName(email.sender)}
                </span>
                <span className="personal-email-subject">
                  {email.subject?.trim() || "(no subject)"}
                </span>
                <span className="personal-email-time">
                  {formatRelative(email.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {emailsErr && (
          <div className="personal-card-error">{emailsErr}</div>
        )}
      </section>
    </div>
  );
}
