// Platform-wide error log dashboard. Shows everything ingested by
// /api/error-logs — uncaught JS errors, unhandled promise rejections,
// failed API calls, and (when called from handlers) server-side
// internal faults. Gated by `logs:read` + platform scope.

import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  ErrorLogRow,
  ErrorLogStats,
  ErrorSeverity,
  ErrorSource,
  listErrorLogs,
} from "../api/errorLogs";
import { fmtDateTime } from "../utils/datetime";
import "./platformTeam.css";
import "./platformLogs.css";

function fmtDate(value: string): string {
  return fmtDateTime(value);
}

function shortStack(stack: string | null, lines = 4): string {
  if (!stack) return "";
  return stack.split("\n").slice(0, lines).join("\n");
}

export default function PlatformLogs() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" &&
    (hasPermission(user, "logs:read") ||
      hasPermission(user, "logs:read_limited"));

  const [rows, setRows] = useState<ErrorLogRow[]>([]);
  const [stats, setStats] = useState<ErrorLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [sourceFilter, setSourceFilter] = useState<ErrorSource | "">("");
  const [severityFilter, setSeverityFilter] = useState<ErrorSeverity | "">("");
  const [q, setQ] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      const data = await listErrorLogs({
        source: sourceFilter || undefined,
        severity: severityFilter || undefined,
        q: q.trim() || undefined,
        limit: 300,
      });
      setRows(data.logs);
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [canView, sourceFilter, severityFilter, q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Auto-refresh while the toggle is on. 15s feels live without
  // hammering the DB; the dashboard isn't a real-time tail.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, reload]);

  if (!canView) return <Navigate to="/" replace />;
  if (loading && rows.length === 0) {
    return <div className="pt-loader">Loading error log…</div>;
  }

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Error Logs</h1>
        <p>
          Every client + server error captured platform-wide · {user?.email}
        </p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-stats">
        <StatCard label="Errors (1h)" value={stats?.errors_1h ?? 0} alert={(stats?.errors_1h ?? 0) > 0} />
        <StatCard label="Errors (24h)" value={stats?.errors_24h ?? 0} />
        <StatCard label="Client (24h)" value={stats?.client_24h ?? 0} sub="JS + network" />
        <StatCard label="Server (24h)" value={stats?.server_24h ?? 0} sub="Internal faults" />
        <StatCard label="Users affected (24h)" value={stats?.users_24h ?? 0} />
      </section>

      <section className="pt-panel">
        <div className="pt-panel-head logs-filters">
          <h2>Recent errors</h2>
          <input
            className="logs-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search message / URL / user…"
          />
          <select
            className="pt-filter-select"
            value={sourceFilter}
            onChange={(e) =>
              setSourceFilter(e.target.value as ErrorSource | "")
            }
          >
            <option value="">All sources</option>
            <option value="client">Client</option>
            <option value="server">Server</option>
          </select>
          <select
            className="pt-filter-select"
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as ErrorSeverity | "")
            }
          >
            <option value="">All severities</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
          </select>
          <label className="logs-autorefresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button
            type="button"
            className="pt-filter-select"
            onClick={() => void reload()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="pt-empty">
            No errors recorded in the current filter. Quiet skies.
          </div>
        ) : (
          <table className="pt-table logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Severity</th>
                <th>User</th>
                <th>Message</th>
                <th>URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isExpanded = expandedId === r.id;
                return (
                  <>
                    <tr
                      key={r.id}
                      className={`logs-row ${r.severity}`}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : r.id)
                      }
                    >
                      <td className="logs-time">{fmtDate(r.created_at)}</td>
                      <td>
                        <span className={`pt-pill ${r.source}`}>
                          {r.source}
                        </span>
                      </td>
                      <td>
                        <span className={`pt-pill ${r.severity}`}>
                          {r.severity}
                        </span>
                      </td>
                      <td>{r.user_email ?? "anon"}</td>
                      <td className="logs-message">{r.message}</td>
                      <td className="logs-url" title={r.url ?? ""}>
                        {r.url ?? "—"}
                      </td>
                      <td>
                        {r.status_code != null ? (
                          <span className={`pt-pill code-${Math.floor(r.status_code / 100)}xx`}>
                            {r.method ? `${r.method} ` : ""}
                            {r.status_code}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${r.id}-detail`} className="logs-detail-row">
                        <td colSpan={7}>
                          <div className="logs-detail">
                            {r.stack && (
                              <div className="logs-detail-block">
                                <strong>Stack</strong>
                                <pre>{shortStack(r.stack, 10)}</pre>
                              </div>
                            )}
                            {r.extra != null && (
                              <div className="logs-detail-block">
                                <strong>Extra</strong>
                                <pre>{JSON.stringify(r.extra, null, 2)}</pre>
                              </div>
                            )}
                            <div className="logs-detail-grid">
                              <span>
                                <strong>request_id:</strong>{" "}
                                {r.request_id ?? "—"}
                              </span>
                              <span>
                                <strong>session_id:</strong>{" "}
                                {r.session_id ?? "—"}
                              </span>
                              <span className="logs-detail-ua">
                                <strong>user_agent:</strong>{" "}
                                {r.user_agent ?? "—"}
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: number;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div className={`pt-stat ${alert ? "alert" : ""}`}>
      <span className="pt-stat-label">{label}</span>
      <span className="pt-stat-value">{value}</span>
      {sub && <span className="pt-stat-sub">{sub}</span>}
    </div>
  );
}
