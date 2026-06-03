import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { hasPermission } from "../auth/permissions";
import { useAuth } from "../auth/useAuth";
import {
  downloadAuditExport,
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

function toLocalTime(value: string) {
  return fmtDateTime(value);
}

function csvEscape(value: string | number | null) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export default function AuditSecurity() {
  const { user } = useAuth();
  const canReadAudit = hasPermission(user, "audit:read");
  const canManageSiem = hasPermission(user, "webhooks:manage");

  // Platform-team only. A non-platform user reaching this page via direct
  // URL / stale bookmark gets bounced to /home rather than seeing an empty
  // audit table powered by 403s from the backend. We compute the redirect
  // flag here but DON'T early-return — the hooks below must run on every
  // render to keep the call order stable (Rules of Hooks).
  const shouldRedirect = Boolean(user) && user!.scope !== "platform";

  const [filters, setFilters] = useState<AuditLogFilters>({ limit: 100 });
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");

  const [userActions, setUserActions] = useState<UserActionRow[]>([]);
  const [userActionsError, setUserActionsError] = useState("");
  const [userActionSearch, setUserActionSearch] = useState("");

  const [siem, setSiem] = useState<SiemSettings | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [siemLoading, setSiemLoading] = useState(false);
  const [siemMessage, setSiemMessage] = useState("");
  const [siemError, setSiemError] = useState("");

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
      setAuditError(err instanceof Error ? err.message : "Failed to load audit logs");
    } finally {
      setAuditLoading(false);
    }
  }, [canReadAudit, filters]);

  const loadUserActions = useCallback(async () => {
    if (!canReadAudit) return;
    setUserActionsError("");
    try {
      setUserActions(await listUserActions({ limit: 200 }));
    } catch (err) {
      setUserActionsError(
        err instanceof Error ? err.message : "Failed to load user actions",
      );
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
      setSiemError(err instanceof Error ? err.message : "Failed to load SIEM settings");
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
      void loadUserActions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadUserActions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSiem();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSiem]);

  const filteredUserActions = useMemo(() => {
    const q = userActionSearch.trim().toLowerCase();
    if (!q) return userActions;
    return userActions.filter((a) =>
      [a.actor_email, a.action, a.resource_type, a.resource_id, a.ip].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [userActions, userActionSearch]);

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
      setSiemError(err instanceof Error ? err.message : "Failed to save SIEM settings");
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
      setSiemError(err instanceof Error ? err.message : "Failed to send test event");
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
      setAuditError(`Exported ${count} rows. Re-run with X-Audit-Next-Cursor for the next page.`);
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
    return <Navigate to="/home" replace />;
  }

  if (!canReadAudit && !canManageSiem) {
    return (
      <div className="audit-security-page">
        <h1>Security</h1>
        <p className="audit-security-empty">You do not have permission to view security settings.</p>
      </div>
    );
  }

  return (
    <div className="audit-security-page">
      <header className="audit-security-header">
        <div>
          <h1>Security</h1>
          <p>Audit activity and SIEM forwarding for this workspace.</p>
        </div>
        {canReadAudit && (
          <button type="button" onClick={() => void loadAudit()} disabled={auditLoading}>
            {auditLoading ? "Refreshing..." : "Refresh"}
          </button>
        )}
      </header>

      {canReadAudit && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>Audit log</h2>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={exportCsv} disabled={rows.length === 0}>
                Export view (CSV)
              </button>
              <button type="button" onClick={() => void downloadServerExport("jsonl")}>
                Bulk JSONL
              </button>
              <button type="button" onClick={() => void downloadServerExport("csv")}>
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
                  setFilters((prev) => ({ ...prev, outcome: event.target.value || undefined }))
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
                  setFilters((prev) => ({ ...prev, api_key_id: event.target.value }))
                }
              />
            </label>
            <label>
              <span>User ID</span>
              <input
                inputMode="numeric"
                value={filters.user_id ?? ""}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, user_id: event.target.value }))
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
                  setFilters((prev) => ({ ...prev, limit: Number(event.target.value) }))
                }
              />
            </label>
            <button type="submit" disabled={auditLoading}>Apply</button>
          </form>

          <div className="audit-summary">
            {Object.entries(outcomeCounts).map(([outcome, count]) => (
              <span key={outcome}>
                <strong>{count}</strong> {outcome}
              </span>
            ))}
            {rows.length === 0 && <span>No rows loaded</span>}
          </div>

          {auditError && <div className="audit-security-error">{auditError}</div>}
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
                        <span className={`audit-outcome ${row.outcome}`}>{row.outcome}</span>
                      </td>
                      <td>{row.api_key_name ?? row.key_preview ?? row.api_key_id ?? "-"}</td>
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

      {canReadAudit && (
        <section className="audit-security-panel">
          <div className="audit-security-panel-head">
            <h2>User actions</h2>
            <input
              type="search"
              className="audit-user-search"
              placeholder="Search user, action, resource…"
              value={userActionSearch}
              onChange={(e) => setUserActionSearch(e.target.value)}
              aria-label="Search user actions"
            />
          </div>
          <p className="audit-security-sub">
            Password changes, deletions, file downloads/exports and billing
            changes. Also written to logs/user_actions.log.
          </p>
          {userActionsError && (
            <div className="audit-security-error">{userActionsError}</div>
          )}
          {filteredUserActions.length === 0 ? (
            <div className="audit-security-empty">
              {userActions.length === 0
                ? "No user actions recorded yet."
                : "No matches for that search."}
            </div>
          ) : (
            <div className="audit-table-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUserActions.map((a) => (
                    <tr key={a.id}>
                      <td>{toLocalTime(a.created_at)}</td>
                      <td>{a.actor_email ?? a.actor_user_id ?? "-"}</td>
                      <td>
                        <span className={`audit-outcome ${a.action}`}>
                          {a.action}
                        </span>
                      </td>
                      <td className="audit-path">
                        {a.resource_type
                          ? `${a.resource_type}${a.resource_id ? `#${a.resource_id}` : ""}`
                          : "-"}
                      </td>
                      <td>{a.ip ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canManageSiem && (
        <section className="audit-security-panel">
          <h2>SIEM webhook</h2>
          <form className="siem-form" onSubmit={(event) => void submitSiem(event)}>
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
                placeholder={siem?.token_configured ? "Configured; leave blank to keep" : "Optional"}
              />
            </label>
            <div className="siem-meta">
              <span>Scope: {siem?.scope ?? user?.scope ?? "-"}</span>
              <span>Source: {siem?.source ?? "-"}</span>
              <span>Token: {siem?.token_configured ? "configured" : "not configured"}</span>
            </div>
            {siemError && <div className="audit-security-error">{siemError}</div>}
            {siemMessage && <div className="audit-security-success">{siemMessage}</div>}
            <div className="siem-actions">
              <button type="submit" disabled={siemLoading}>
                {siemLoading ? "Saving..." : "Save settings"}
              </button>
              <button type="button" onClick={() => void sendTest()} disabled={siemLoading || !enabled}>
                Send test event
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
