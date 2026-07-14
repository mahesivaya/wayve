import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { hasPermission } from "../auth/permissions";
import { useAuth } from "../auth/useAuth";
import {
  downloadAuditExport,
  formatUserActionDetails,
  getSiemSettings,
  listAuditLogs,
  listUserActions,
  saveSiemSettings,
  testSiemSettings,
  type AuditLogFilters,
  type AuditLogRow,
  type SiemSettings,
  type UserActionRow,
} from "../api/audit";
import { fmtDateTime } from "../utils/datetime";
import "./auditSecurity.css";

const OUTCOMES = [
  "",
  "allowed",
  "denied_scope",
  "denied_expired",
  "denied_revoked",
  "rate_limited",
  "invalid",
];

// Sign-in lifecycle events, already recorded in `audit_logs` by the auth
// handlers on every login, logout, failed login and password change.
const SESSION_ACTIONS = new Set([
  "login",
  "logout",
  "login_failed",
  "password_change",
]);

// Mailbox events surfaced in the "Audit emails activity" table.
const EMAIL_ACTIONS = new Set([
  "email_sent",
  "email_received",
  "email_read",
  "email_deleted",
  "email_account_delete",
]);

const EMAIL_ACTION_LABEL: Record<string, string> = {
  email_sent: "Sent",
  email_received: "Received",
  email_read: "Read",
  email_deleted: "Deleted",
  email_account_delete: "Account removed",
};

// Friendly name for the mailbox provider recorded in `metadata.provider`.
const PROVIDER_LABEL: Record<string, string> = {
  google: "Gmail",
  gmail: "Gmail",
  microsoft: "Outlook",
  outlook: "Outlook",
  imap: "IMAP",
  wayve: "Fluxze",
};

function formatProvider(row: UserActionRow): string {
  const p = row.metadata?.provider;
  if (typeof p !== "string" || !p) return "-";
  return PROVIDER_LABEL[p.toLowerCase()] ?? p;
}

// Render the attachment metadata for an email-activity row: filenames when we
// have them, else a count, else a dash.
function formatAttachments(row: UserActionRow): string {
  const names = row.metadata?.attachments;
  if (Array.isArray(names) && names.length > 0) {
    return names.map((n) => String(n)).join(", ");
  }
  const count = row.metadata?.attachment_count;
  if (typeof count === "number" && count > 0) {
    return `${count} file${count === 1 ? "" : "s"}`;
  }
  return "-";
}

// Chat / channel / call events surfaced in the "Audit Chat activity" table.
const CHAT_ACTIONS = new Set([
  "channel_created",
  "channel_joined",
  "channel_left",
  "call",
]);

const CHAT_ACTION_LABEL: Record<string, string> = {
  channel_created: "Channel created",
  channel_joined: "Joined channel",
  channel_left: "Left channel",
};

// Derive a chat row's display label + css class. Calls fan out by media +
// outcome into Audio/Video call, Call failed (declined) and Call not answered.
function chatActivityView(row: UserActionRow): { label: string; cls: string } {
  if (row.action === "call") {
    const media = metaStr(row, "media");
    const outcome =
      typeof row.metadata?.outcome === "string" ? row.metadata.outcome : "";
    if (outcome === "completed") {
      return media === "video"
        ? { label: "Video call", cls: "call_video" }
        : { label: "Audio call", cls: "call_audio" };
    }
    if (outcome === "rejected") {
      return { label: "Call failed", cls: "call_failed" };
    }
    return { label: "Call not answered", cls: "call_missed" };
  }
  return {
    label: CHAT_ACTION_LABEL[row.action] ?? row.action,
    cls: row.action,
  };
}

// Talk-time for completed calls as m:ss; dash for channel events / unanswered.
function formatDuration(row: UserActionRow): string {
  const s = row.metadata?.duration_seconds;
  if (typeof s !== "number" || s < 0) return "-";
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Meeting / calendar events surfaced in the "Audit calendar activity" table.
const CALENDAR_ACTIONS = new Set([
  "meeting_created",
  "meeting_updated",
  "meeting_canceled",
  "meeting_invited",
]);

const CALENDAR_ACTION_LABEL: Record<string, string> = {
  meeting_created: "Meeting created",
  meeting_updated: "Meeting updated",
  meeting_canceled: "Meeting canceled",
  meeting_invited: "Invitation received",
};

function hhmm(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 5) : "";
}

// "09:00 – 10:30" from the meeting's start/end wall-clock times.
function formatMeetingTime(row: UserActionRow): string {
  const start = hhmm(row.metadata?.start_time);
  const end = hhmm(row.metadata?.end_time);
  if (!start && !end) return "-";
  return `${start || "?"} – ${end || "?"}`;
}

// Scheduled length (end − start) as "1h 30m" / "45m".
function formatMeetingDuration(row: UserActionRow): string {
  const start = row.metadata?.start_time;
  const end = row.metadata?.end_time;
  if (typeof start !== "string" || typeof end !== "string") return "-";
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const diff = toMin(end) - toMin(start);
  if (!Number.isFinite(diff) || diff <= 0) return "-";
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function formatInvitees(row: UserActionRow): string {
  const list = row.metadata?.participants;
  if (Array.isArray(list) && list.length > 0) {
    return list.map((p) => String(p)).join(", ");
  }
  return "-";
}

// Drive / files / folders events surfaced in the "Audit Drive activity" table.
const DRIVE_ACTIONS = new Set([
  "file_upload",
  "file_download",
  "file_delete",
  "file_rename",
  "folder_create",
  "folder_rename",
  "folder_delete",
]);

const DRIVE_ACTION_LABEL: Record<string, string> = {
  file_upload: "File uploaded",
  file_download: "File downloaded",
  file_delete: "File deleted",
  file_rename: "File renamed",
  folder_create: "Folder created",
  folder_rename: "Folder renamed",
  folder_delete: "Folder deleted",
};

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

function formatSize(row: UserActionRow): string {
  const s = row.metadata?.size;
  if (typeof s !== "number" || s < 0) return "-";
  return fmtBytes(s);
}

// Tooltip for a drive row's name cell — shows the prior name on a rename.
function driveNameTitle(row: UserActionRow): string {
  const old = row.metadata?.old_name;
  if (typeof old === "string" && old) return `renamed from "${old}"`;
  return metaStr(row, "name");
}

// Notes events surfaced in the "Audit Notes activity" table.
const NOTES_ACTIONS = new Set([
  "note_created",
  "note_renamed",
  "note_updated",
  "note_deleted",
]);

const NOTE_ACTION_LABEL: Record<string, string> = {
  note_created: "Note created",
  note_renamed: "Note renamed",
  note_updated: "Note updated",
  note_deleted: "Note deleted",
};

// Tasks events surfaced in the "Audit tasks activity" table.
const TASK_ACTIONS = new Set([
  "task_created",
  "task_status_changed",
  "task_updated",
  "task_deleted",
]);

const TASK_ACTION_LABEL: Record<string, string> = {
  task_created: "Task created",
  task_status_changed: "Status changed",
  task_updated: "Task updated",
  task_deleted: "Task deleted",
};

const TASK_STATUS_LABEL: Record<string, string> = {
  to_do: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

const PRIORITY_LABEL: Record<number, string> = {
  1: "Lowest",
  2: "Low",
  3: "Medium",
  4: "High",
  5: "Highest",
};

const stLabel = (s: string) => TASK_STATUS_LABEL[s] ?? s;

// Org/platform-only fields read "No Data available" for personal users, who
// have no assigner/assignee concept.
function noData(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "No Data available";
}

// The task's effective status: the new status on a change row, else its status.
function taskStatusOf(row: UserActionRow): string {
  const s =
    row.action === "task_status_changed"
      ? row.metadata?.new_status
      : row.metadata?.status;
  return typeof s === "string" ? s : "";
}

function formatTaskStatus(row: UserActionRow): string {
  if (row.action === "task_status_changed") {
    return `${stLabel(metaStr(row, "old_status"))} → ${stLabel(metaStr(row, "new_status"))}`;
  }
  const s = metaStr(row, "status");
  return s === "-" ? "-" : stLabel(s);
}

function formatPriority(row: UserActionRow): string {
  const p = row.metadata?.priority;
  if (typeof p !== "number") return "-";
  return PRIORITY_LABEL[p] ?? String(p);
}

// "Assigned to me" from the task owner's perspective: assignee == actor email.
function assignedToMe(row: UserActionRow): string {
  const assignee = row.metadata?.assignee;
  if (typeof assignee !== "string" || !assignee.trim())
    return "No Data available";
  const me = (row.actor_email ?? "").toLowerCase();
  return assignee.trim().toLowerCase() === me ? "Yes" : "No";
}

function formatAttachmentsCount(row: UserActionRow): string {
  const c = row.metadata?.attachments;
  if (typeof c !== "number" || c <= 0) return "-";
  return `${c} file${c === 1 ? "" : "s"}`;
}

const ACTION_LABEL: Record<string, string> = {
  login: "Login",
  logout: "Logout",
  login_failed: "Login failed",
  password_change: "Password change",
};

function metaStr(row: UserActionRow, key: string): string {
  const v = row.metadata?.[key];
  return typeof v === "string" && v ? v : "-";
}

// Sign-in method as recorded in the audit metadata (`metadata.method`).
const METHOD_LABEL: Record<string, string> = {
  password: "Password",
  google: "Google",
  microsoft: "Microsoft",
  outlook: "Microsoft",
};

function toLocalTime(value: string) {
  return fmtDateTime(value);
}

function formatLocation(row: UserActionRow): string {
  return [row.city, row.region, row.country].filter(Boolean).join(", ") || "-";
}

// A `login` row with `new_user: true` is the first sign-in of a freshly
// registered account (password signup or OAuth), so surface it as "Registered"
// with the method, distinct from an ordinary login.
function activityView(row: UserActionRow): { label: string; cls: string } {
  const meta = row.metadata ?? {};
  const rawMethod = typeof meta.method === "string" ? meta.method : "";
  const method = METHOD_LABEL[rawMethod] ?? rawMethod;
  if (row.action === "login") {
    const isNew = meta.new_user === true;
    const base = isNew ? "Registered" : "Login";
    return {
      label: method ? `${base} · ${method}` : base,
      cls: isNew ? "registered" : "login",
    };
  }
  return { label: ACTION_LABEL[row.action] ?? row.action, cls: row.action };
}

function csvEscape(value: string | number | null) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

// One tab per table; only the active tab's section renders. `perm` gates which
// tabs a user sees: the audit tables need audit:read, the SIEM panel needs
// webhooks:manage.
const AUDIT_TABS = [
  { key: "access", label: "Access", perm: "read" },
  { key: "emails", label: "Emails", perm: "read" },
  { key: "chat", label: "Chat", perm: "read" },
  { key: "calendar", label: "Calendar", perm: "read" },
  { key: "drive", label: "Drive", perm: "read" },
  { key: "notes", label: "Notes", perm: "read" },
  { key: "tasks", label: "Tasks", perm: "read" },
  { key: "auditlog", label: "Audit log", perm: "read" },
  { key: "siem", label: "SIEM webhook", perm: "siem" },
] as const;

type AuditTab = (typeof AUDIT_TABS)[number]["key"];

export default function AuditSecurity({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { user } = useAuth();
  const canReadAudit = hasPermission(user, "audit:read");
  const canManageSiem = hasPermission(user, "webhooks:manage");

  // Default to the first table the user can see; a SIEM-only manager (no
  // audit:read) lands on the SIEM tab instead of an empty page.
  const [tab, setTab] = useState<AuditTab>(canReadAudit ? "access" : "siem");

  // Owners only, mirroring the backend's require_owner gate: even platform
  // super_admin and security, who hold audit:read, are bounced. Computed without
  // an early return so the hooks below keep a stable call order.
  const isOwner =
    user?.effective_role === "owner" &&
    (user?.scope === "platform" || user?.scope === "organization");
  const shouldRedirect = Boolean(user) && !isOwner;

  const [filters, setFilters] = useState<AuditLogFilters>({ limit: 100 });
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");

  const [actions, setActions] = useState<UserActionRow[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsError, setActionsError] = useState("");

  // Every per-table filter below is applied client-side over the loaded rows.
  const [actStart, setActStart] = useState("");
  const [actEnd, setActEnd] = useState("");
  const [actEmail, setActEmail] = useState("");
  const [actType, setActType] = useState("");

  const [emUser, setEmUser] = useState("");
  const [emType, setEmType] = useState("");
  const [emFrom, setEmFrom] = useState("");
  const [emTo, setEmTo] = useState("");

  const [chUser, setChUser] = useState("");
  const [chType, setChType] = useState("");
  const [chChannel, setChChannel] = useState("");

  const [calUser, setCalUser] = useState("");
  const [calType, setCalType] = useState("");
  const [calMeeting, setCalMeeting] = useState("");

  const [drvType, setDrvType] = useState("");
  const [drvStart, setDrvStart] = useState("");
  const [drvEnd, setDrvEnd] = useState("");
  const [drvMinMb, setDrvMinMb] = useState("");

  const [ntName, setNtName] = useState("");
  const [ntStart, setNtStart] = useState("");
  const [ntEnd, setNtEnd] = useState("");

  const [tkUser, setTkUser] = useState("");
  const [tkSummary, setTkSummary] = useState("");
  const [tkStatus, setTkStatus] = useState("");

  const [siem, setSiem] = useState<SiemSettings | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [siemLoading, setSiemLoading] = useState(false);
  const [siemMessage, setSiemMessage] = useState("");
  const [siemError, setSiemError] = useState("");

  // The activity filter matches the derived kind, so "registered" excludes plain
  // logins and vice versa; every other value matches the raw action.
  const filteredActions = useMemo(() => {
    const email = actEmail.trim().toLowerCase();
    // `actEnd` is an inclusive day, so compare against end-of-day.
    const startMs = actStart
      ? new Date(`${actStart}T00:00:00`).getTime()
      : null;
    const endMs = actEnd ? new Date(`${actEnd}T23:59:59.999`).getTime() : null;
    return actions.filter((row) => {
      if (!SESSION_ACTIONS.has(row.action)) return false;
      if (email && !(row.actor_email ?? "").toLowerCase().includes(email)) {
        return false;
      }
      if (actType) {
        const cls = activityView(row).cls;
        if (actType === "registered" || actType === "login") {
          if (cls !== actType) return false;
        } else if (row.action !== actType) {
          return false;
        }
      }
      if (startMs != null || endMs != null) {
        const t = new Date(row.created_at).getTime();
        if (startMs != null && t < startMs) return false;
        if (endMs != null && t > endMs) return false;
      }
      return true;
    });
  }, [actions, actStart, actEnd, actEmail, actType]);

  const emailActions = useMemo(() => {
    const user = emUser.trim().toLowerCase();
    const from = emFrom.trim().toLowerCase();
    const to = emTo.trim().toLowerCase();
    return actions.filter((row) => {
      if (!EMAIL_ACTIONS.has(row.action)) return false;
      if (emType && row.action !== emType) return false;
      if (user && !(row.actor_email ?? "").toLowerCase().includes(user)) {
        return false;
      }
      if (from && !metaStr(row, "from").toLowerCase().includes(from)) {
        return false;
      }
      if (to && !metaStr(row, "to").toLowerCase().includes(to)) return false;
      return true;
    });
  }, [actions, emUser, emType, emFrom, emTo]);

  const emFiltersActive = Boolean(emUser || emType || emFrom || emTo);

  const clearEmFilters = () => {
    setEmUser("");
    setEmType("");
    setEmFrom("");
    setEmTo("");
  };

  const chatActions = useMemo(() => {
    const user = chUser.trim().toLowerCase();
    const channel = chChannel.trim().toLowerCase();
    return actions.filter((row) => {
      if (!CHAT_ACTIONS.has(row.action)) return false;
      // chType matches the derived cls (channel_* or call_audio/video/failed/missed).
      if (chType && chatActivityView(row).cls !== chType) return false;
      if (user && !(row.actor_email ?? "").toLowerCase().includes(user)) {
        return false;
      }
      if (channel && !metaStr(row, "channel").toLowerCase().includes(channel)) {
        return false;
      }
      return true;
    });
  }, [actions, chUser, chType, chChannel]);

  const chFiltersActive = Boolean(chUser || chType || chChannel);

  const clearChFilters = () => {
    setChUser("");
    setChType("");
    setChChannel("");
  };

  const calendarActions = useMemo(() => {
    const user = calUser.trim().toLowerCase();
    const meeting = calMeeting.trim().toLowerCase();
    return actions.filter((row) => {
      if (!CALENDAR_ACTIONS.has(row.action)) return false;
      if (calType && row.action !== calType) return false;
      if (user && !(row.actor_email ?? "").toLowerCase().includes(user)) {
        return false;
      }
      if (meeting && !metaStr(row, "title").toLowerCase().includes(meeting)) {
        return false;
      }
      return true;
    });
  }, [actions, calUser, calType, calMeeting]);

  const calFiltersActive = Boolean(calUser || calType || calMeeting);

  const clearCalFilters = () => {
    setCalUser("");
    setCalType("");
    setCalMeeting("");
  };

  const driveActions = useMemo(() => {
    const startMs = drvStart
      ? new Date(`${drvStart}T00:00:00`).getTime()
      : null;
    const endMs = drvEnd ? new Date(`${drvEnd}T23:59:59.999`).getTime() : null;
    const minBytes = drvMinMb ? Number(drvMinMb) * 1024 * 1024 : 0;
    return actions.filter((row) => {
      if (!DRIVE_ACTIONS.has(row.action)) return false;
      if (drvType && row.action !== drvType) return false;
      if (minBytes > 0) {
        const size = row.metadata?.size;
        if (typeof size !== "number" || size < minBytes) return false;
      }
      if (startMs != null || endMs != null) {
        const t = new Date(row.created_at).getTime();
        if (startMs != null && t < startMs) return false;
        if (endMs != null && t > endMs) return false;
      }
      return true;
    });
  }, [actions, drvType, drvStart, drvEnd, drvMinMb]);

  const drvFiltersActive = Boolean(drvType || drvStart || drvEnd || drvMinMb);

  const clearDrvFilters = () => {
    setDrvType("");
    setDrvStart("");
    setDrvEnd("");
    setDrvMinMb("");
  };

  const notesActions = useMemo(() => {
    const name = ntName.trim().toLowerCase();
    const startMs = ntStart ? new Date(`${ntStart}T00:00:00`).getTime() : null;
    const endMs = ntEnd ? new Date(`${ntEnd}T23:59:59.999`).getTime() : null;
    return actions.filter((row) => {
      if (!NOTES_ACTIONS.has(row.action)) return false;
      if (name && !metaStr(row, "name").toLowerCase().includes(name)) {
        return false;
      }
      if (startMs != null || endMs != null) {
        const t = new Date(row.created_at).getTime();
        if (startMs != null && t < startMs) return false;
        if (endMs != null && t > endMs) return false;
      }
      return true;
    });
  }, [actions, ntName, ntStart, ntEnd]);

  const ntFiltersActive = Boolean(ntName || ntStart || ntEnd);

  const clearNtFilters = () => {
    setNtName("");
    setNtStart("");
    setNtEnd("");
  };

  const tasksActions = useMemo(() => {
    const user = tkUser.trim().toLowerCase();
    const summary = tkSummary.trim().toLowerCase();
    return actions.filter((row) => {
      if (!TASK_ACTIONS.has(row.action)) return false;
      if (user && !(row.actor_email ?? "").toLowerCase().includes(user)) {
        return false;
      }
      if (summary && !metaStr(row, "summary").toLowerCase().includes(summary)) {
        return false;
      }
      if (tkStatus && taskStatusOf(row) !== tkStatus) return false;
      return true;
    });
  }, [actions, tkUser, tkSummary, tkStatus]);

  const tkFiltersActive = Boolean(tkUser || tkSummary || tkStatus);

  const clearTkFilters = () => {
    setTkUser("");
    setTkSummary("");
    setTkStatus("");
  };

  const actFiltersActive = Boolean(actStart || actEnd || actEmail || actType);

  const clearActFilters = () => {
    setActStart("");
    setActEnd("");
    setActEmail("");
    setActType("");
  };

  const outcomeCounts = useMemo(() => {
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {});
  }, [rows]);

  const loadAudit = useCallback(async () => {
    if (!canReadAudit) return;
    setAuditLoading(true);
    setAuditError("");
    try {
      setRows(await listAuditLogs(filters));
    } catch (err) {
      setAuditError(
        err instanceof Error ? err.message : "Failed to load audit logs"
      );
    } finally {
      setAuditLoading(false);
    }
  }, [canReadAudit, filters]);

  // The backend returns a broader set of security-relevant actions, so only the
  // session lifecycle events are kept here.
  const loadActions = useCallback(async () => {
    if (!canReadAudit) return;
    setActionsLoading(true);
    setActionsError("");
    try {
      setActions(await listUserActions({ limit: 500 }));
    } catch (err) {
      setActionsError(
        err instanceof Error ? err.message : "Failed to load user activity"
      );
    } finally {
      setActionsLoading(false);
    }
  }, [canReadAudit]);

  const loadSiem = useCallback(async () => {
    if (!canManageSiem) return;
    setSiemLoading(true);
    setSiemError("");
    try {
      const settings = await getSiemSettings();
      setSiem(settings);
      setWebhookUrl(settings.webhook_url);
      setEnabled(settings.enabled);
    } catch (err) {
      setSiemError(
        err instanceof Error ? err.message : "Failed to load SIEM settings"
      );
    } finally {
      setSiemLoading(false);
    }
  }, [canManageSiem]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAudit();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAudit]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadActions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadActions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSiem();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSiem]);

  async function submitSiem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSiemLoading(true);
    setSiemMessage("");
    setSiemError("");
    try {
      const saved = await saveSiemSettings({
        webhook_url: webhookUrl,
        webhook_token: webhookToken || undefined,
        enabled,
      });
      setSiem(saved);
      setWebhookToken("");
      setSiemMessage("SIEM settings saved.");
    } catch (err) {
      setSiemError(
        err instanceof Error ? err.message : "Failed to save SIEM settings"
      );
    } finally {
      setSiemLoading(false);
    }
  }

  async function sendTest() {
    setSiemLoading(true);
    setSiemMessage("");
    setSiemError("");
    try {
      const result = await testSiemSettings();
      setSiemMessage(`Test event delivered. Status ${result.status}.`);
    } catch (err) {
      setSiemError(
        err instanceof Error ? err.message : "Failed to send test event"
      );
    } finally {
      setSiemLoading(false);
    }
  }

  async function downloadServerExport(format: "jsonl" | "csv") {
    try {
      const { blob, count } = await downloadAuditExport(format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setAuditError(
        `Exported ${count} rows. Re-run with X-Audit-Next-Cursor for the next page.`
      );
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Bulk export failed");
    }
  }

  function exportCsv() {
    const header = [
      "created_at",
      "method",
      "path",
      "status_code",
      "outcome",
      "api_key_id",
      "api_key_name",
      "user_id",
      "ip",
    ];
    const body = rows.map((row) =>
      [
        row.created_at,
        row.method,
        row.path,
        row.status_code,
        row.outcome,
        row.api_key_id,
        row.api_key_name,
        row.user_id,
        row.ip,
      ]
        .map(csvEscape)
        .join(",")
    );
    const blob = new Blob([[header.join(","), ...body].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-log.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (shouldRedirect) {
    return embedded ? (
      <div style={{ padding: 16, color: "#6b7280" }}>
        You don't have access to this log.
      </div>
    ) : (
      <Navigate to="/home" replace />
    );
  }

  if (!canReadAudit && !canManageSiem) {
    return (
      <div className="audit-security-page">
        <h1>Audit Logs</h1>
        <p className="audit-security-empty">
          You do not have permission to view security settings.
        </p>
      </div>
    );
  }

  return (
    <div className="audit-security-page audit-security-tabbed">
      <header className="audit-security-header">
        <div>
          <h1>Audit Logs</h1>
          <p>
            API-key &amp; auth audit activity and SIEM forwarding for this
            workspace.
          </p>
        </div>
        {canReadAudit && (
          <button
            type="button"
            onClick={() => {
              void loadActions();
              void loadAudit();
            }}
            disabled={auditLoading || actionsLoading}
          >
            {auditLoading || actionsLoading ? "Refreshing..." : "Refresh"}
          </button>
        )}
      </header>

      <nav className="audit-tabs" role="tablist" aria-label="Audit views">
        {AUDIT_TABS.filter((t) =>
          t.perm === "siem" ? canManageSiem : canReadAudit
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`audit-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {canReadAudit && tab === "access" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit Access activity</h2>
          </div>
          <p className="audit-security-sub">
            Every sign-in event — new registrations, login, logout, failed login
            attempts, and password changes.
          </p>

          <form
            className="audit-filters audit-activity-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>Start date</span>
              <input
                type="date"
                value={actStart}
                max={actEnd || undefined}
                onChange={(event) => setActStart(event.target.value)}
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                value={actEnd}
                min={actStart || undefined}
                onChange={(event) => setActEnd(event.target.value)}
              />
            </label>
            <label>
              <span>User email</span>
              <input
                type="text"
                value={actEmail}
                placeholder="name@example.com"
                onChange={(event) => setActEmail(event.target.value)}
              />
            </label>
            <label>
              <span>Activity</span>
              <select
                value={actType}
                onChange={(event) => setActType(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="registered">Registered</option>
                <option value="login">Login</option>
                <option value="logout">Logout</option>
                <option value="login_failed">Login failed</option>
                <option value="password_change">Password change</option>
              </select>
            </label>
            <button
              type="button"
              onClick={clearActFilters}
              disabled={!actFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsError && (
            <div className="audit-security-error">{actionsError}</div>
          )}
          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : actions.length === 0 ? (
            <div className="audit-security-empty">No user activity yet.</div>
          ) : filteredActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>IP</th>
                    <th>Location</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActions.map((row) => {
                    const act = activityView(row);
                    return (
                      <tr key={row.id}>
                        <td>{toLocalTime(row.created_at)}</td>
                        <td>
                          {row.actor_email ??
                            (row.actor_user_id != null
                              ? `user#${row.actor_user_id}`
                              : "-")}
                        </td>
                        <td>
                          <span className={`audit-activity ${act.cls}`}>
                            {act.label}
                          </span>
                        </td>
                        <td>{row.ip ?? "-"}</td>
                        <td>{formatLocation(row)}</td>
                        <td
                          className="audit-path"
                          title={formatUserActionDetails(row) || "-"}
                        >
                          {formatUserActionDetails(row) || "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "emails" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit emails activity</h2>
          </div>
          <p className="audit-security-sub">
            Mailbox events — messages sent, received, read, deleted, and mailbox
            removals.
          </p>

          <form
            className="audit-filters audit-email-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>User email</span>
              <input
                type="text"
                value={emUser}
                placeholder="actor@example.com"
                onChange={(event) => setEmUser(event.target.value)}
              />
            </label>
            <label>
              <span>Activity</span>
              <select
                value={emType}
                onChange={(event) => setEmType(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="email_sent">Sent</option>
                <option value="email_received">Received</option>
                <option value="email_read">Read</option>
                <option value="email_deleted">Deleted</option>
                <option value="email_account_delete">Account removed</option>
              </select>
            </label>
            <label>
              <span>From</span>
              <input
                type="text"
                value={emFrom}
                placeholder="sender"
                onChange={(event) => setEmFrom(event.target.value)}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="text"
                value={emTo}
                placeholder="recipient"
                onChange={(event) => setEmTo(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={clearEmFilters}
              disabled={!emFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => EMAIL_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">No email activity yet.</div>
          ) : emailActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Provider</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Subject</th>
                    <th>Attachments</th>
                  </tr>
                </thead>
                <tbody>
                  {emailActions.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>
                        {row.actor_email ??
                          (row.actor_user_id != null
                            ? `user#${row.actor_user_id}`
                            : "-")}
                      </td>
                      <td>
                        <span className={`audit-activity ${row.action}`}>
                          {EMAIL_ACTION_LABEL[row.action] ?? row.action}
                        </span>
                      </td>
                      <td>{formatProvider(row)}</td>
                      <td className="audit-path" title={metaStr(row, "from")}>
                        {metaStr(row, "from")}
                      </td>
                      <td className="audit-path" title={metaStr(row, "to")}>
                        {metaStr(row, "to")}
                      </td>
                      <td
                        className="audit-path"
                        title={metaStr(row, "subject")}
                      >
                        {metaStr(row, "subject")}
                      </td>
                      <td className="audit-path" title={formatAttachments(row)}>
                        {formatAttachments(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "chat" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit Chat activity</h2>
          </div>
          <p className="audit-security-sub">
            Channels created, joined and left, plus audio / video calls with
            duration, declined and unanswered calls.
          </p>

          <form
            className="audit-filters audit-chat-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>User email</span>
              <input
                type="text"
                value={chUser}
                placeholder="actor@example.com"
                onChange={(event) => setChUser(event.target.value)}
              />
            </label>
            <label>
              <span>Activity</span>
              <select
                value={chType}
                onChange={(event) => setChType(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="channel_created">Channel created</option>
                <option value="channel_joined">Joined channel</option>
                <option value="channel_left">Left channel</option>
                <option value="call_audio">Audio call</option>
                <option value="call_video">Video call</option>
                <option value="call_failed">Call failed</option>
                <option value="call_missed">Call not answered</option>
              </select>
            </label>
            <label>
              <span>Channel</span>
              <input
                type="text"
                value={chChannel}
                placeholder="channel name"
                onChange={(event) => setChChannel(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={clearChFilters}
              disabled={!chFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => CHAT_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">No chat activity yet.</div>
          ) : chatActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Channel</th>
                    <th>Peer</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {chatActions.map((row) => {
                    const act = chatActivityView(row);
                    return (
                      <tr key={row.id}>
                        <td>{toLocalTime(row.created_at)}</td>
                        <td>
                          {row.actor_email ??
                            (row.actor_user_id != null
                              ? `user#${row.actor_user_id}`
                              : "-")}
                        </td>
                        <td>
                          <span className={`audit-activity ${act.cls}`}>
                            {act.label}
                          </span>
                        </td>
                        <td
                          className="audit-path"
                          title={metaStr(row, "channel")}
                        >
                          {metaStr(row, "channel")}
                        </td>
                        <td
                          className="audit-path"
                          title={metaStr(row, "peer_email")}
                        >
                          {metaStr(row, "peer_email")}
                        </td>
                        <td>{formatDuration(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "calendar" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit calendar activity</h2>
          </div>
          <p className="audit-security-sub">
            Meetings created, updated and canceled — with date, timings,
            duration and invitee list — plus invitations received.
          </p>

          <form
            className="audit-filters audit-chat-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>User email</span>
              <input
                type="text"
                value={calUser}
                placeholder="actor@example.com"
                onChange={(event) => setCalUser(event.target.value)}
              />
            </label>
            <label>
              <span>Activity</span>
              <select
                value={calType}
                onChange={(event) => setCalType(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="meeting_created">Meeting created</option>
                <option value="meeting_updated">Meeting updated</option>
                <option value="meeting_canceled">Meeting canceled</option>
                <option value="meeting_invited">Invitation received</option>
              </select>
            </label>
            <label>
              <span>Meeting</span>
              <input
                type="text"
                value={calMeeting}
                placeholder="meeting title"
                onChange={(event) => setCalMeeting(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={clearCalFilters}
              disabled={!calFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => CALENDAR_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">
              No calendar activity yet.
            </div>
          ) : calendarActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Meeting</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Duration</th>
                    <th>Invitees</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {calendarActions.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>
                        {row.actor_email ??
                          (row.actor_user_id != null
                            ? `user#${row.actor_user_id}`
                            : "-")}
                      </td>
                      <td>
                        <span className={`audit-activity ${row.action}`}>
                          {CALENDAR_ACTION_LABEL[row.action] ?? row.action}
                        </span>
                      </td>
                      <td className="audit-path" title={metaStr(row, "title")}>
                        {metaStr(row, "title")}
                      </td>
                      <td>{metaStr(row, "date")}</td>
                      <td>{formatMeetingTime(row)}</td>
                      <td>{formatMeetingDuration(row)}</td>
                      <td className="audit-path" title={formatInvitees(row)}>
                        {formatInvitees(row)}
                      </td>
                      <td>{metaStr(row, "status")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "drive" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit Drive activity</h2>
          </div>
          <p className="audit-security-sub">
            Files uploaded, downloaded, renamed and deleted (with size and
            folder), plus folders created, renamed and deleted.
          </p>

          <form
            className="audit-filters audit-activity-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>Activity</span>
              <select
                value={drvType}
                onChange={(event) => setDrvType(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="file_upload">File uploaded</option>
                <option value="file_download">File downloaded</option>
                <option value="file_delete">File deleted</option>
                <option value="file_rename">File renamed</option>
                <option value="folder_create">Folder created</option>
                <option value="folder_rename">Folder renamed</option>
                <option value="folder_delete">Folder deleted</option>
              </select>
            </label>
            <label>
              <span>Start date</span>
              <input
                type="date"
                value={drvStart}
                max={drvEnd || undefined}
                onChange={(event) => setDrvStart(event.target.value)}
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                value={drvEnd}
                min={drvStart || undefined}
                onChange={(event) => setDrvEnd(event.target.value)}
              />
            </label>
            <label>
              <span>Min size (MB)</span>
              <input
                type="number"
                min={0}
                value={drvMinMb}
                placeholder="0"
                onChange={(event) => setDrvMinMb(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={clearDrvFilters}
              disabled={!drvFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => DRIVE_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">No drive activity yet.</div>
          ) : driveActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Name</th>
                    <th>Folder</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {driveActions.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>
                        {row.actor_email ??
                          (row.actor_user_id != null
                            ? `user#${row.actor_user_id}`
                            : "-")}
                      </td>
                      <td>
                        <span className={`audit-activity ${row.action}`}>
                          {DRIVE_ACTION_LABEL[row.action] ?? row.action}
                        </span>
                      </td>
                      <td className="audit-path" title={driveNameTitle(row)}>
                        {metaStr(row, "name")}
                      </td>
                      <td className="audit-path" title={metaStr(row, "folder")}>
                        {metaStr(row, "folder")}
                      </td>
                      <td>{formatSize(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "notes" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit Notes activity</h2>
          </div>
          <p className="audit-security-sub">
            Notes created, renamed, updated and deleted — with size.
          </p>

          <form
            className="audit-filters audit-chat-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>Note name</span>
              <input
                type="text"
                value={ntName}
                placeholder="note title"
                onChange={(event) => setNtName(event.target.value)}
              />
            </label>
            <label>
              <span>Start date</span>
              <input
                type="date"
                value={ntStart}
                max={ntEnd || undefined}
                onChange={(event) => setNtStart(event.target.value)}
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                value={ntEnd}
                min={ntStart || undefined}
                onChange={(event) => setNtEnd(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={clearNtFilters}
              disabled={!ntFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => NOTES_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">No notes activity yet.</div>
          ) : notesActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Name</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {notesActions.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>
                        {row.actor_email ??
                          (row.actor_user_id != null
                            ? `user#${row.actor_user_id}`
                            : "-")}
                      </td>
                      <td>
                        <span className={`audit-activity ${row.action}`}>
                          {NOTE_ACTION_LABEL[row.action] ?? row.action}
                        </span>
                      </td>
                      <td className="audit-path" title={metaStr(row, "name")}>
                        {metaStr(row, "name")}
                      </td>
                      <td>{formatSize(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "tasks" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit tasks activity</h2>
          </div>
          <p className="audit-security-sub">
            Tasks created and deleted, every status change, with priority,
            assigner / assignee and attachments. Org-only fields read “No Data
            available” for personal accounts.
          </p>

          <form
            className="audit-filters audit-chat-filters"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              <span>User email</span>
              <input
                type="text"
                value={tkUser}
                placeholder="actor@example.com"
                onChange={(event) => setTkUser(event.target.value)}
              />
            </label>
            <label>
              <span>Summary</span>
              <input
                type="text"
                value={tkSummary}
                placeholder="task summary"
                onChange={(event) => setTkSummary(event.target.value)}
              />
            </label>
            <label>
              <span>Status</span>
              <select
                value={tkStatus}
                onChange={(event) => setTkStatus(event.target.value)}
              >
                <option value="">All statuses</option>
                <option value="to_do">To do</option>
                <option value="in_progress">In progress</option>
                <option value="in_review">In review</option>
                <option value="done">Done</option>
              </select>
            </label>
            <button
              type="button"
              onClick={clearTkFilters}
              disabled={!tkFiltersActive}
            >
              Clear
            </button>
          </form>

          {actionsLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : !actions.some((r) => TASK_ACTIONS.has(r.action)) ? (
            <div className="audit-security-empty">No tasks activity yet.</div>
          ) : tasksActions.length === 0 ? (
            <div className="audit-security-empty">
              No activity matches these filters.
            </div>
          ) : (
            <div className="audit-table-wrap audit-table-wrap--scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Activity</th>
                    <th>Summary</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Assigned by</th>
                    <th>Assignee</th>
                    <th>Assigned to me</th>
                    <th>Attachments</th>
                  </tr>
                </thead>
                <tbody>
                  {tasksActions.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>
                        {row.actor_email ??
                          (row.actor_user_id != null
                            ? `user#${row.actor_user_id}`
                            : "-")}
                      </td>
                      <td>
                        <span className={`audit-activity ${row.action}`}>
                          {TASK_ACTION_LABEL[row.action] ?? row.action}
                        </span>
                      </td>
                      <td
                        className="audit-path"
                        title={metaStr(row, "summary")}
                      >
                        {metaStr(row, "summary")}
                      </td>
                      <td>{formatTaskStatus(row)}</td>
                      <td>{formatPriority(row)}</td>
                      <td>{noData(row.metadata?.assigned_by)}</td>
                      <td>{noData(row.metadata?.assignee)}</td>
                      <td>{assignedToMe(row)}</td>
                      <td>{formatAttachmentsCount(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canReadAudit && tab === "auditlog" && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit log</h2>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={exportCsv}
                disabled={rows.length === 0}
              >
                Export view (CSV)
              </button>
              <button
                type="button"
                onClick={() => void downloadServerExport("jsonl")}
              >
                Bulk JSONL
              </button>
              <button
                type="button"
                onClick={() => void downloadServerExport("csv")}
              >
                Bulk CSV
              </button>
            </div>
          </div>

          <form
            className="audit-filters"
            onSubmit={(event) => {
              event.preventDefault();
              void loadAudit();
            }}
          >
            <label>
              <span>Outcome</span>
              <select
                value={filters.outcome ?? ""}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    outcome: event.target.value || undefined,
                  }))
                }
              >
                {OUTCOMES.map((outcome) => (
                  <option key={outcome || "all"} value={outcome}>
                    {outcome || "All outcomes"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>API key ID</span>
              <input
                inputMode="numeric"
                value={filters.api_key_id ?? ""}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    api_key_id: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>User ID</span>
              <input
                inputMode="numeric"
                value={filters.user_id ?? ""}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    user_id: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Limit</span>
              <input
                type="number"
                min={1}
                max={500}
                value={filters.limit ?? 100}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    limit: Number(event.target.value),
                  }))
                }
              />
            </label>
            <button type="submit" disabled={auditLoading}>
              Apply
            </button>
          </form>

          <div className="audit-summary">
            {Object.entries(outcomeCounts).map(([outcome, count]) => (
              <span key={outcome}>
                <strong>{count}</strong> {outcome}
              </span>
            ))}
            {rows.length === 0 && <span>No rows loaded</span>}
          </div>

          {auditError && (
            <div className="audit-security-error">{auditError}</div>
          )}
          {auditLoading ? (
            <div className="audit-security-empty">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="audit-security-empty">No audit events found.</div>
          ) : (
            <div className="audit-table-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>Key</th>
                    <th>User</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{toLocalTime(row.created_at)}</td>
                      <td>{row.method}</td>
                      <td className="audit-path">{row.path}</td>
                      <td>{row.status_code}</td>
                      <td>
                        <span className={`audit-outcome ${row.outcome}`}>
                          {row.outcome}
                        </span>
                      </td>
                      <td>
                        {row.api_key_name ??
                          row.key_preview ??
                          row.api_key_id ??
                          "-"}
                      </td>
                      <td>{row.user_id ?? "-"}</td>
                      <td>{row.ip ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canManageSiem && tab === "siem" && (
        <section className="audit-security-panel">
          <h2>SIEM webhook</h2>
          <form
            className="siem-form"
            onSubmit={(event) => void submitSiem(event)}
          >
            <label className="siem-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>Forward audit events</span>
            </label>
            <label>
              <span>Webhook URL</span>
              <input
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
                placeholder="https://siem.example.com/events"
              />
            </label>
            <label>
              <span>Bearer token</span>
              <input
                type="password"
                value={webhookToken}
                onChange={(event) => setWebhookToken(event.target.value)}
                placeholder={
                  siem?.token_configured
                    ? "Configured; leave blank to keep"
                    : "Optional"
                }
              />
            </label>
            <div className="siem-meta">
              <span>Scope: {siem?.scope ?? user?.scope ?? "-"}</span>
              <span>Source: {siem?.source ?? "-"}</span>
              <span>
                Token:{" "}
                {siem?.token_configured ? "configured" : "not configured"}
              </span>
            </div>
            {siemError && (
              <div className="audit-security-error">{siemError}</div>
            )}
            {siemMessage && (
              <div className="audit-security-success">{siemMessage}</div>
            )}
            <div className="siem-actions">
              <button type="submit" disabled={siemLoading}>
                {siemLoading ? "Saving..." : "Save settings"}
              </button>
              <button
                type="button"
                onClick={() => void sendTest()}
                disabled={siemLoading || !enabled}
              >
                Send test event
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
