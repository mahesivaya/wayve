import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { lookupUserAudit, type UserActionRow } from "../api/audit";
import { lookupUserActivity, type ActivityEventRow } from "../api/activity";
import { fmtDateTime } from "../utils/datetime";
import "./auditSecurity.css";

const ACTIVITY_KIND_LABEL: Record<string, string> = {
  page_view: "Page view",
  click: "Click",
  api_request: "API request",
};

// Detail line for a non-consequential row: the page path, the click target, or
// "METHOD /path → status" for an API request.
function describeActivity(ev: ActivityEventRow): string {
  if (ev.kind === "api_request") {
    const head = `${ev.method ?? "?"} ${ev.path ?? ""}`.trim();
    return ev.status_code != null ? `${head} → ${ev.status_code}` : head;
  }
  return ev.label || ev.path || "-";
}

// Map a raw audit action to a coarse category for the unified timeline.
function categoryOf(action: string): string {
  if (["login", "logout", "login_failed", "password_change"].includes(action)) {
    return "Access";
  }
  if (action.startsWith("email_")) return "Email";
  if (action.startsWith("channel_") || action === "call") return "Chat";
  if (action.startsWith("meeting_")) return "Calendar";
  if (action.startsWith("file_") || action.startsWith("folder_")) return "Drive";
  if (action.startsWith("note_")) return "Notes";
  if (action.startsWith("task_")) return "Tasks";
  return "Other";
}

// Friendly label for every action we record across the app.
const LABELS: Record<string, string> = {
  login: "Login",
  logout: "Logout",
  login_failed: "Login failed",
  password_change: "Password change",
  email_sent: "Email sent",
  email_received: "Email received",
  email_read: "Email read",
  email_deleted: "Email deleted",
  email_account_delete: "Mailbox removed",
  channel_created: "Channel created",
  channel_joined: "Channel joined",
  channel_left: "Channel left",
  call: "Call",
  meeting_created: "Meeting created",
  meeting_updated: "Meeting updated",
  meeting_canceled: "Meeting canceled",
  meeting_invited: "Invitation received",
  file_upload: "File uploaded",
  file_download: "File downloaded",
  file_delete: "File deleted",
  file_rename: "File renamed",
  folder_create: "Folder created",
  folder_rename: "Folder renamed",
  folder_delete: "Folder deleted",
  note_created: "Note created",
  note_renamed: "Note renamed",
  note_updated: "Note updated",
  note_deleted: "Note deleted",
  task_created: "Task created",
  task_status_changed: "Task status changed",
  task_updated: "Task updated",
  task_deleted: "Task deleted",
};

function labelOf(row: UserActionRow): string {
  if (row.action === "call") {
    const media = typeof row.metadata?.media === "string" ? row.metadata.media : "";
    const outcome =
      typeof row.metadata?.outcome === "string" ? row.metadata.outcome : "";
    if (outcome === "completed") {
      return media === "video" ? "Video call" : "Audio call";
    }
    if (outcome === "rejected") return "Call failed";
    if (outcome === "missed") return "Call not answered";
  }
  return LABELS[row.action] ?? row.action;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Compact human-readable detail line from the row's metadata.
function describe(row: UserActionRow): string {
  const m = row.metadata;
  if (!m || typeof m !== "object") return "-";
  const str = (k: string) => (typeof m[k] === "string" && m[k] ? (m[k] as string) : null);
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);

  const parts: string[] = [];
  const primary = str("name") ?? str("summary") ?? str("title") ?? str("channel");
  if (primary) parts.push(primary);
  if (str("from") && str("to")) parts.push(`${m.from} → ${m.to}`);
  if (str("subject")) parts.push(str("subject") as string);
  if (m.old_status || m.new_status) {
    parts.push(`${m.old_status ?? "?"} → ${m.new_status ?? "?"}`);
  }
  if (str("peer_email")) parts.push(`peer ${m.peer_email}`);
  if (str("folder")) parts.push(`in ${m.folder}`);
  if (str("provider")) parts.push(str("provider") as string);
  if (str("method")) parts.push(str("method") as string);
  if (str("reason")) parts.push(str("reason") as string);
  const dur = num("duration_seconds");
  if (dur != null) parts.push(fmtDuration(dur));
  const size = num("size");
  if (size != null && size > 0) parts.push(fmtBytes(size));
  return parts.length ? parts.join(" · ") : "-";
}

export default function UserAudit() {
  const { user } = useAuth();
  const isOwner =
    user?.effective_role === "owner" &&
    (user?.scope === "platform" || user?.scope === "organization");
  const shouldRedirect = Boolean(user) && !isOwner;

  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<UserActionRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityEventRow[] | null>(null);
  const [resolved, setResolved] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = email.trim();
    if (!target) return;
    setLoading(true);
    setError("");
    setRows(null);
    setActivity(null);
    try {
      const result = await lookupUserAudit(target);
      setResolved(result.user.email);
      setRows(result.actions);
      // Non-consequential stream is best-effort — a failure here shouldn't
      // hide the consequential results.
      try {
        const act = await lookupUserActivity(target);
        setActivity(act.events);
      } catch {
        setActivity([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  if (shouldRedirect) {
    return <Navigate to="/home" replace />;
  }

  return (
    <div className="audit-security-page">
      <header className="audit-security-header">
        <div>
          <h1>User Audit</h1>
          <p>
            Enter a user's email to see their complete activity across access,
            email, chat, calendar, drive, notes and tasks — newest first.
          </p>
        </div>
      </header>

      <section className="audit-security-panel">
        <form className="user-audit-form" onSubmit={onSubmit}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            aria-label="User email"
            className="user-audit-input"
          />
          <button type="submit" disabled={loading || !email.trim()}>
            {loading ? "Searching..." : "Submit"}
          </button>
        </form>

        {error && <div className="audit-security-error">{error}</div>}

        {rows != null && (
          <>
            <div className="audit-security-sub" style={{ marginTop: 14 }}>
              {rows.length === 0
                ? `No activity recorded for ${resolved}.`
                : `${rows.length} event${rows.length === 1 ? "" : "s"} for ${resolved}`}
            </div>
            {rows.length > 0 && (
              <div className="audit-table-wrap audit-table-wrap--scroll">
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Category</th>
                      <th>Activity</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{fmtDateTime(row.created_at)}</td>
                        <td>
                          <span className="audit-activity">
                            {categoryOf(row.action)}
                          </span>
                        </td>
                        <td>{labelOf(row)}</td>
                        <td className="audit-path" title={describe(row)}>
                          {describe(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {activity != null && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>All Non-consequential Audits</h2>
          </div>
          <p className="audit-security-sub">
            Page views, UI clicks and every API request for {resolved} — last 7
            days, newest first.
          </p>
          {activity.length === 0 ? (
            <div className="audit-security-empty">
              No non-consequential activity recorded.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Kind</th>
                    <th>Detail</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((ev) => (
                    <tr key={ev.id}>
                      <td>{fmtDateTime(ev.created_at)}</td>
                      <td>
                        <span className="audit-activity">
                          {ACTIVITY_KIND_LABEL[ev.kind] ?? ev.kind}
                        </span>
                      </td>
                      <td
                        className="audit-path"
                        title={describeActivity(ev)}
                      >
                        {describeActivity(ev)}
                      </td>
                      <td>{ev.ip ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
