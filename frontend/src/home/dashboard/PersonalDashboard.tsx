import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import {
  getHomeToday,
  getHomeTasks,
  type MeetingPreview,
  type TaskPreview,
} from "../../api/home";
import { getEmails } from "../../api/email";
import { updateTaskApi } from "../../api/tasks";
import type { EmailItem } from "../../emails/types";
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
  new Date().toLocaleDateString(undefined, {
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
        setEmails(result.emails);
        // Use the unread subset of the loaded page as a lower-bound
        // count; the precise number lives in /api/home/inbox but for
        // this layout the bar above the list is enough.
        setUnreadCount(result.emails.filter((e) => !e.is_read).length);
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

  const meetingsLoading = meetings === null;
  const tasksLoading = tasks === null;
  const emailsLoading = emails === null;

  const totalsLabel = [
    tasks ? `${tasks.length} open task${tasks.length === 1 ? "" : "s"}` : null,
    emails ? `${unreadCount.toLocaleString()} unread` : null,
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
                onClick={() => navigate("/emails")}
              >
                <span className="personal-email-dot" aria-hidden="true" />
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
