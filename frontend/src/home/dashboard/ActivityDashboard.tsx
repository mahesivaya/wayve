import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { getMeetings } from "../../api/scheduler";
import { getEmails } from "../../api/email";
import { getTasks, type Task } from "../../api/tasks";
import { getNotes, type Note } from "../../api/notes";
import type { EmailItem } from "../../emails/types";
import "./dashboard.css";

// Backend shape from GET /api/meetings — matches `ApiMeeting` in Scheduler.tsx.
type ApiMeeting = {
  id: number;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  participants?: string[] | null;
};

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const formatTime = (hhmm: string) => {
  // Accepts "09:00" or "09:00:00".
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
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
};

const senderName = (sender: string | null | undefined) => {
  if (!sender) return "Unknown";
  // "Name <email@x>" → "Name" else "email@x" → local part else raw.
  const m = sender.match(/^"?([^"<]+?)"?\s*<.*>$/);
  if (m) return m[1].trim();
  if (sender.includes("@")) return sender.split("@")[0];
  return sender;
};

const TASK_STATUS_LABEL: Record<Task["status"], string> = {
  to_do: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export default function ActivityDashboard() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<ApiMeeting[] | null>(null);
  const [emails, setEmails] = useState<EmailItem[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [captureValue, setCaptureValue] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadMeetings = async () => {
      try {
        const data = (await getMeetings()) as ApiMeeting[];
        if (!cancelled) setMeetings(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setMeetings([]);
      }
    };

    const loadEmails = async () => {
      try {
        const data = await getEmails<EmailItem>({ folder: "inbox" });
        if (!cancelled) setEmails(data.emails);
      } catch {
        if (!cancelled) setEmails([]);
      }
    };

    const loadTasks = async () => {
      try {
        const data = await getTasks();
        if (!cancelled) setTasks(data);
      } catch {
        if (!cancelled) setTasks([]);
      }
    };

    const loadNotes = async () => {
      try {
        const data = await getNotes();
        if (!cancelled) setNotes(data);
      } catch {
        if (!cancelled) setNotes([]);
      }
    };

    void Promise.all([loadMeetings(), loadEmails(), loadTasks(), loadNotes()]);

    return () => {
      cancelled = true;
    };
  }, []);

  const today = todayISO();
  const todaysMeetings = (meetings ?? [])
    .filter((m) => m.date === today)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .slice(0, 5);

  const unreadEmails = (emails ?? []).filter((e) => !e.is_read);
  const unreadPreview = unreadEmails.slice(0, 5);

  const openTasks = (tasks ?? [])
    .filter((t) => t.status !== "done")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);

  // Recent: notes (by updated_at) merged with 3 most recent emails.
  // Drive/chat omitted in v1 — would need a dedicated activity endpoint to
  // keep this fast and complete.
  const recentNotes = (notes ?? []).map((n) => ({
    type: "note" as const,
    id: n.id,
    title: n.title?.trim() || "(untitled)",
    ts: n.updated_at ?? "",
    path: "/notes",
  }));
  const recentEmails = (emails ?? []).slice(0, 3).map((e) => ({
    type: "email" as const,
    id: e.id,
    title: e.subject?.trim() || "(no subject)",
    ts: e.created_at,
    path: "/emails",
  }));
  const recent = [...recentNotes, ...recentEmails]
    .filter((r) => r.ts)
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
    .slice(0, 5);

  function submitCapture(e: FormEvent) {
    e.preventDefault();
    const value = captureValue.trim();
    if (!value) return;
    // V1: route to AI Chat. The query lands as the user's next message
    // once /aichat learns to accept a `?q=` entry-point.
    setCaptureValue("");
    void navigate("/aichat");
  }

  const meetingsLoading = meetings === null;
  const emailsLoading = emails === null;
  const tasksLoading = tasks === null;
  const recentLoading = emails === null || notes === null;

  return (
    <div className="dashboard">
      <form className="dashboard-capture" onSubmit={submitCapture}>
        <span className="dashboard-capture-icon" aria-hidden="true">✨</span>
        <input
          type="text"
          className="dashboard-capture-input"
          placeholder="What do you want to do?"
          value={captureValue}
          onChange={(ev) => setCaptureValue(ev.target.value)}
          aria-label="Quick capture"
        />
        <button
          type="submit"
          className="dashboard-capture-btn"
          aria-label="Submit"
          disabled={!captureValue.trim()}
        >
          ↵
        </button>
      </form>

      <div className="dashboard-grid">
        {/* TODAY */}
        <section className="dashboard-card">
          <header className="dashboard-card-head">
            <h3>Today</h3>
            {!meetingsLoading && (
              <span className="dashboard-card-count">
                {todaysMeetings.length} event{todaysMeetings.length === 1 ? "" : "s"}
              </span>
            )}
          </header>
          {meetingsLoading ? (
            <DashboardSkeleton rows={3} />
          ) : todaysMeetings.length === 0 ? (
            <p className="dashboard-empty">Nothing scheduled today.</p>
          ) : (
            <ul className="dashboard-list">
              {todaysMeetings.map((m) => (
                <li
                  key={m.id}
                  className="dashboard-item"
                  onClick={() => navigate("/scheduler")}
                >
                  <span className="dashboard-item-lead">{formatTime(m.start_time)}</span>
                  <span className="dashboard-item-title">{m.title}</span>
                  <span className="dashboard-item-trail">
                    {m.participants?.length
                      ? `${m.participants.length} ppl`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="dashboard-card-link"
            onClick={() => navigate("/scheduler")}
          >
            Open scheduler →
          </button>
        </section>

        {/* INBOX */}
        <section className="dashboard-card">
          <header className="dashboard-card-head">
            <h3>Inbox</h3>
            {!emailsLoading && (
              <span className="dashboard-card-count">
                {unreadEmails.length} unread
              </span>
            )}
          </header>
          {emailsLoading ? (
            <DashboardSkeleton rows={3} />
          ) : unreadPreview.length === 0 ? (
            <p className="dashboard-empty">Inbox zero.</p>
          ) : (
            <ul className="dashboard-list">
              {unreadPreview.map((e) => (
                <li
                  key={e.id}
                  className="dashboard-item dashboard-item-stack"
                  onClick={() => navigate("/emails")}
                >
                  <span className="dashboard-item-lead">{senderName(e.sender)}</span>
                  <span className="dashboard-item-title">
                    {e.subject?.trim() || "(no subject)"}
                  </span>
                  <span className="dashboard-item-trail">
                    {formatRelative(e.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="dashboard-card-link"
            onClick={() => navigate("/emails")}
          >
            Open inbox →
          </button>
        </section>

        {/* TASKS */}
        <section className="dashboard-card">
          <header className="dashboard-card-head">
            <h3>Tasks</h3>
            {!tasksLoading && (
              <span className="dashboard-card-count">
                {openTasks.length} open
              </span>
            )}
          </header>
          {tasksLoading ? (
            <DashboardSkeleton rows={3} />
          ) : openTasks.length === 0 ? (
            <p className="dashboard-empty">Nothing on your plate.</p>
          ) : (
            <ul className="dashboard-list">
              {openTasks.map((t) => (
                <li
                  key={t.id}
                  className="dashboard-item"
                  onClick={() => navigate("/tasks")}
                >
                  <span className="dashboard-item-lead" aria-hidden="true">◯</span>
                  <span className="dashboard-item-title">{t.name}</span>
                  <span className="dashboard-item-trail">
                    {TASK_STATUS_LABEL[t.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="dashboard-card-link"
            onClick={() => navigate("/tasks")}
          >
            Open tasks →
          </button>
        </section>

        {/* RECENT */}
        <section className="dashboard-card">
          <header className="dashboard-card-head">
            <h3>Recent</h3>
          </header>
          {recentLoading ? (
            <DashboardSkeleton rows={3} />
          ) : recent.length === 0 ? (
            <p className="dashboard-empty">Activity will appear here.</p>
          ) : (
            <ul className="dashboard-list">
              {recent.map((r) => (
                <li
                  key={`${r.type}-${r.id}`}
                  className="dashboard-item"
                  onClick={() => navigate(r.path)}
                >
                  <span className="dashboard-item-lead" aria-hidden="true">
                    {r.type === "note" ? "📝" : "📧"}
                  </span>
                  <span className="dashboard-item-title">{r.title}</span>
                  <span className="dashboard-item-trail">{formatRelative(r.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function DashboardSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="dashboard-list dashboard-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="dashboard-skeleton-row" aria-hidden="true" />
      ))}
    </ul>
  );
}
