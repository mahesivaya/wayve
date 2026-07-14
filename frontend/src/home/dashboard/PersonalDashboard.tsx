import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getHomeToday,
  getHomeTasks,
  type MeetingPreview,
  type TaskPreview,
} from "../../api/home";
import { getEmails, markEmailRead } from "../../api/email";
import { loadCached, saveCached } from "./useCardData";

// Ids of emails opened from this card, so the next mount of the home page shows
// them as read even before /api/emails has caught up with the backend write.
// Bounded so it can't grow without limit.
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
    const arr = Array.from(current);
    const trimmed = arr.slice(Math.max(0, arr.length - RECENT_READ_MAX));
    sessionStorage.setItem(RECENT_READ_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore — private mode / quota
  }
}
import { updateTaskApi } from "../../api/tasks";
import type { EmailItem } from "../../emails/types";
import "./personalDashboard.css";

// Home layout for personal accounts. Org / platform-admin users get the 2×2
// ActivityDashboard instead.

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

export default function PersonalDashboard() {
  const navigate = useNavigate();

  // Seed from sessionStorage so a return visit to /home paints instantly; the
  // mount fetch below still refreshes in the background. Keys are namespaced
  // "personal.*" so they don't collide with ActivityDashboard's snapshots.
  const [meetings, setMeetings] = useState<MeetingPreview[] | null>(() =>
    loadCached<MeetingPreview[]>("personal.meetings")
  );
  const [tasks, setTasks] = useState<TaskPreview[] | null>(() =>
    loadCached<TaskPreview[]>("personal.tasks")
  );
  const [emails, setEmails] = useState<EmailItem[] | null>(() =>
    loadCached<EmailItem[]>("personal.emails")
  );
  const [, setUnreadCount] = useState<number>(
    () =>
      loadCached<EmailItem[]>("personal.emails")?.filter((e) => !e.is_read)
        .length ?? 0
  );
  const [meetingsErr, setMeetingsErr] = useState<string | null>(null);
  const [tasksErr, setTasksErr] = useState<string | null>(null);
  const [emailsErr, setEmailsErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getHomeToday()
      .then((data) => {
        if (cancelled) return;
        setMeetings(data.events);
        saveCached("personal.meetings", data.events);
      })
      .catch((err) => {
        if (!cancelled) {
          setMeetingsErr(err instanceof Error ? err.message : "Failed to load");
          setMeetings([]);
        }
      });

    getHomeTasks()
      .then((data) => {
        if (cancelled) return;
        setTasks(data.top);
        saveCached("personal.tasks", data.top);
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
        // Emails opened from this card render as read immediately, even if the
        // backend write hadn't completed by the time we re-fetched.
        const recent = loadRecentlyRead();
        const merged =
          recent.size === 0
            ? result.emails
            : result.emails.map((email) =>
                recent.has(email.id) && email.is_read === false
                  ? { ...email, is_read: true }
                  : email
              );
        setEmails(merged);
        saveCached("personal.emails", merged);
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
      setTasks((prev) => (prev ?? []).filter((t) => t.id !== task.id));
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
          err instanceof Error ? err.message : "Failed to complete task"
        );
      }
    },
    [tasks]
  );

  // Marks read optimistically in the list and in sessionStorage (so a fast
  // back-nav from /emails still sees the row as read) before navigating. The
  // /emails page's openEmail no-ops its own markEmailRead when is_read is
  // already true, so the POST isn't duplicated.
  const openEmailFromHome = (email: EmailItem) => {
    if (email.is_read === false) {
      markRecentlyRead(email.id);
      setEmails((prev) =>
        prev
          ? prev.map((row) =>
              row.id === email.id ? { ...row, is_read: true } : row
            )
          : prev
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      void markEmailRead(email.id).catch(() => {
        // Best-effort — useEmailInbox.openEmail retries once /emails picks up
        // the deep link.
      });
    }
    void navigate(`/emails?open=${email.id}`);
  };

  const meetingsLoading = meetings === null;
  const tasksLoading = tasks === null;
  const emailsLoading = emails === null;

  return (
    <div className="personal-dashboard">
      <div className="personal-dashboard-row">
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

        <section className="personal-card">
          <header className="personal-card-head">
            <h2>Task</h2>
            <button
              type="button"
              className="personal-card-action"
              onClick={() => navigate("/tasks")}
            >
              Open tasks →
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
      </div>

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
                  {/* Inline SVG rather than an emoji glyph so the envelope
                      renders identically on every OS. */}
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

        {emailsErr && <div className="personal-card-error">{emailsErr}</div>}
      </section>
    </div>
  );
}
