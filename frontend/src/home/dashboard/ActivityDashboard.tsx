import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  getHomeSummary,
  type HomeSummary,
  type RecentItem,
} from "../../api/home";
import "./dashboard.css";

const formatTime = (hhmm: string) => {
  // Backend serialises start_time/end_time as "HH:MM" (24h).
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
  const m = sender.match(/^"?([^"<]+?)"?\s*<.*>$/);
  if (m) return m[1].trim();
  if (sender.includes("@")) return sender.split("@")[0];
  return sender;
};

// Map server-side status (`to_do | in_progress | in_review | done`) to a
// human label. Done is filtered out by the backend, but keep the entry so
// the type stays exhaustive.
const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

// SessionStorage cache — paints the dashboard instantly on repeat visits
// while the freshfetch runs in the background. Keyed per-tab so a logout
// doesn't bleed across users.
const CACHE_KEY = "rwayve.home.summary";

function loadCachedSummary(): HomeSummary | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as HomeSummary;
  } catch {
    return null;
  }
}

function saveCachedSummary(summary: HomeSummary) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(summary));
  } catch {
    // ignore — private mode / quota
  }
}

export default function ActivityDashboard() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<HomeSummary | null>(loadCachedSummary);
  const [captureValue, setCaptureValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    getHomeSummary()
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        saveCachedSummary(data);
      })
      .catch(() => {
        // Leave the cached value rendered if the refresh fails — better
        // than a flash-of-empty-state. If there was no cache, fall back
        // to the empty shape so the cards render their empty messages.
        if (cancelled) return;
        if (!summary) {
          setSummary({
            today: { events: [] },
            inbox: { unread_count: 0, preview: [] },
            tasks: { top: [] },
            recent: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Intentionally fetches once on mount. The `summary` reference in the
    // catch above is only read to gate a fallback assignment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitCapture(e: FormEvent) {
    e.preventDefault();
    const value = captureValue.trim();
    if (!value) return;
    setCaptureValue("");
    void navigate("/aichat");
  }

  const loading = summary === null;
  const events = summary?.today.events ?? [];
  const unreadPreview = summary?.inbox.preview ?? [];
  const unreadCount = summary?.inbox.unread_count ?? 0;
  const openTasks = summary?.tasks.top ?? [];
  const recent = summary?.recent ?? [];

  function navigateForRecent(item: RecentItem) {
    void navigate(item.kind === "note" ? "/notes" : "/emails");
  }

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
            {!loading && (
              <span className="dashboard-card-count">
                {events.length} event{events.length === 1 ? "" : "s"}
              </span>
            )}
          </header>
          {loading ? (
            <DashboardSkeleton rows={3} />
          ) : events.length === 0 ? (
            <p className="dashboard-empty">Nothing scheduled today.</p>
          ) : (
            <ul className="dashboard-list">
              {events.map((m) => (
                <li
                  key={m.id}
                  className="dashboard-item"
                  onClick={() => navigate("/scheduler")}
                >
                  <span className="dashboard-item-lead">{formatTime(m.start_time)}</span>
                  <span className="dashboard-item-title">{m.title}</span>
                  <span className="dashboard-item-trail">
                    {m.participants_count > 0 ? `${m.participants_count} ppl` : ""}
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
            {!loading && (
              <span className="dashboard-card-count">{unreadCount} unread</span>
            )}
          </header>
          {loading ? (
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
            {!loading && (
              <span className="dashboard-card-count">{openTasks.length} open</span>
            )}
          </header>
          {loading ? (
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
                    {TASK_STATUS_LABEL[t.status] ?? t.status}
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
          {loading ? (
            <DashboardSkeleton rows={3} />
          ) : recent.length === 0 ? (
            <p className="dashboard-empty">Activity will appear here.</p>
          ) : (
            <ul className="dashboard-list">
              {recent.map((r) => (
                <li
                  key={`${r.kind}-${r.id}`}
                  className="dashboard-item"
                  onClick={() => navigateForRecent(r)}
                >
                  <span className="dashboard-item-lead" aria-hidden="true">
                    {r.kind === "note" ? "📝" : "📧"}
                  </span>
                  <span className="dashboard-item-title">
                    {r.title?.trim() || (r.kind === "note" ? "(untitled)" : "(no subject)")}
                  </span>
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
