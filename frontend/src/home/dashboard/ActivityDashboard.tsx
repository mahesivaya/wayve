import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  getHomeInbox,
  getHomeRecent,
  getHomeTasks,
  getHomeToday,
  type EmailPreview,
  type InboxSummary,
  type MeetingPreview,
  type RecentItem,
  type TaskPreview,
  type TodaySummary,
} from "../../api/home";
import { useCardData } from "./useCardData";
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

const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export default function ActivityDashboard() {
  const navigate = useNavigate();
  const [captureValue, setCaptureValue] = useState("");

  // Four independent fetches kick off together on mount; each card
  // renders the instant its own promise resolves. Tasks/Today (cheap
  // queries) typically paint in <100ms; Inbox/Recent (joins + AES
  // decryption) follow when their queries complete.
  const today = useCardData<TodaySummary>("today", getHomeToday);
  const inbox = useCardData<InboxSummary>("inbox", getHomeInbox);
  const tasks = useCardData<{ top: TaskPreview[] }>("tasks", getHomeTasks);
  const recent = useCardData<RecentItem[]>("recent", getHomeRecent);

  function submitCapture(e: FormEvent) {
    e.preventDefault();
    const value = captureValue.trim();
    if (!value) return;
    setCaptureValue("");
    void navigate("/ai-chat");
  }

  function navigateForRecent(item: RecentItem) {
    void navigate(item.kind === "note" ? "/notes" : "/emails");
  }

  return (
    <div className="dashboard">
      <form className="dashboard-capture" onSubmit={submitCapture}>
        <span className="dashboard-capture-icon" aria-hidden="true">
          ✨
        </span>
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
        <TodayCard
          data={today.data}
          loading={today.loading}
          onOpen={() => navigate("/scheduler")}
        />
        <InboxCard
          data={inbox.data}
          loading={inbox.loading}
          onOpen={() => navigate("/emails")}
        />
        <TasksCard
          data={tasks.data}
          loading={tasks.loading}
          onOpen={() => navigate("/tasks")}
        />
        <RecentCard
          data={recent.data}
          loading={recent.loading}
          onOpenItem={navigateForRecent}
        />
      </div>
    </div>
  );
}

// ─────────────────────────── Cards ────────────────────────────

type CardProps<T> = {
  data: T | null;
  loading: boolean;
  onOpen?: () => void;
};

function TodayCard({ data, loading, onOpen }: CardProps<TodaySummary>) {
  const events: MeetingPreview[] = data?.events ?? [];
  return (
    <section className="dashboard-card">
      <header className="dashboard-card-head">
        <h3>Today</h3>
        {!loading && data && (
          <span className="dashboard-card-count">
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        )}
      </header>
      {loading && !data ? (
        <DashboardSkeleton rows={3} />
      ) : events.length === 0 ? (
        <p className="dashboard-empty">Nothing scheduled today.</p>
      ) : (
        <ul className="dashboard-list">
          {events.map((m) => (
            <li key={m.id} className="dashboard-item" onClick={onOpen}>
              <span className="dashboard-item-lead">
                {formatTime(m.start_time)}
              </span>
              <span className="dashboard-item-title">{m.title}</span>
              <span className="dashboard-item-trail">
                {m.participants_count > 0 ? `${m.participants_count} ppl` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="dashboard-card-link" onClick={onOpen}>
        Open scheduler →
      </button>
    </section>
  );
}

function InboxCard({ data, loading, onOpen }: CardProps<InboxSummary>) {
  const preview: EmailPreview[] = data?.preview ?? [];
  const unread = data?.unread_count ?? 0;
  return (
    <section className="dashboard-card">
      <header className="dashboard-card-head">
        <h3>Inbox</h3>
        {!loading && data && (
          <span className="dashboard-card-count">{unread} unread</span>
        )}
      </header>
      {loading && !data ? (
        <DashboardSkeleton rows={3} />
      ) : preview.length === 0 ? (
        <p className="dashboard-empty">Inbox zero.</p>
      ) : (
        <ul className="dashboard-list">
          {preview.map((e) => (
            <li
              key={e.id}
              className="dashboard-item dashboard-item-stack"
              onClick={onOpen}
            >
              <div className="dashboard-item-stack-main">
                <span className="dashboard-item-lead">
                  {senderName(e.sender)}
                </span>
                <span className="dashboard-item-title">
                  {e.subject?.trim() || "(no subject)"}
                </span>
              </div>
              <span className="dashboard-item-trail">
                {formatRelative(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="dashboard-card-link" onClick={onOpen}>
        Open inbox →
      </button>
    </section>
  );
}

function TasksCard({
  data,
  loading,
  onOpen,
}: CardProps<{ top: TaskPreview[] }>) {
  const items: TaskPreview[] = data?.top ?? [];
  return (
    <section className="dashboard-card">
      <header className="dashboard-card-head">
        <h3>Tasks</h3>
        {!loading && data && (
          <span className="dashboard-card-count">{items.length} open</span>
        )}
      </header>
      {loading && !data ? (
        <DashboardSkeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="dashboard-empty">Nothing on your plate.</p>
      ) : (
        <ul className="dashboard-list">
          {items.map((t) => (
            <li key={t.id} className="dashboard-item" onClick={onOpen}>
              <span className="dashboard-item-lead" aria-hidden="true">
                ◯
              </span>
              <span className="dashboard-item-title">{t.name}</span>
              <span className="dashboard-item-trail">
                {TASK_STATUS_LABEL[t.status] ?? t.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="dashboard-card-link" onClick={onOpen}>
        Open tasks →
      </button>
    </section>
  );
}

function RecentCard({
  data,
  loading,
  onOpenItem,
}: {
  data: RecentItem[] | null;
  loading: boolean;
  onOpenItem: (item: RecentItem) => void;
}) {
  const items = data ?? [];
  return (
    <section className="dashboard-card">
      <header className="dashboard-card-head">
        <h3>Recent</h3>
      </header>
      {loading && !data ? (
        <DashboardSkeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="dashboard-empty">Activity will appear here.</p>
      ) : (
        <ul className="dashboard-list">
          {items.map((r) => (
            <li
              key={`${r.kind}-${r.id}`}
              className="dashboard-item"
              onClick={() => onOpenItem(r)}
            >
              <span className="dashboard-item-lead" aria-hidden="true">
                {r.kind === "note" ? "📝" : "📧"}
              </span>
              <span className="dashboard-item-title">
                {r.title?.trim() ||
                  (r.kind === "note" ? "(untitled)" : "(no subject)")}
              </span>
              <span className="dashboard-item-trail">
                {formatRelative(r.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
