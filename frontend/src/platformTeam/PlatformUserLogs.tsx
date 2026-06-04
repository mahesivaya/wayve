import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  formatUserActionDetails,
  listUserActions,
  type UserActionRow,
} from "../api/audit";
import { fmtDateTime } from "../utils/datetime";
import "./platformTeam.css";

// Security-relevant user actions (sign-in/out, password changes, deletions,
// file downloads/exports, billing changes) from the audit_logs table. Mirrors
// logs/user_actions.log. Scoped by the backend: platform staff see everyone.
export default function PlatformUserLogs() {
  const { user } = useAuth();
  const canView = user?.scope === "platform" && hasPermission(user, "audit:read");

  const [rows, setRows] = useState<UserActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setError("");
    setLoading(true);
    try {
      setRows(await listUserActions({ limit: 500 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user logs");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((a) =>
      [
        a.actor_email,
        a.action,
        a.resource_type,
        a.resource_id,
        a.ip,
        formatUserActionDetails(a),
      ].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search]);

  if (!canView) return <Navigate to="/home" replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>User Logs</h1>
        <p>
          User actions across the platform — sign-ins, email sent/received,
          password changes, deletions, exports and billing changes · {user?.email}
        </p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Activity</h2>
          <input
            type="search"
            className="pt-filter-select"
            placeholder="Search user, action, resource…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search user logs"
          />
        </div>

        {loading ? (
          <div className="pt-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="pt-empty">
            {rows.length === 0
              ? "No user actions recorded yet."
              : "No matches for that search."}
          </div>
        ) : (
          <table className="pt-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Details</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const details = formatUserActionDetails(a);
                return (
                  <tr key={a.id}>
                    <td>{fmtDateTime(a.created_at)}</td>
                    <td>{a.actor_email ?? a.actor_user_id ?? "-"}</td>
                    <td>
                      <span className="pt-pill info">{a.action}</span>
                    </td>
                    <td>
                      {a.resource_type
                        ? `${a.resource_type}${a.resource_id ? `#${a.resource_id}` : ""}`
                        : "-"}
                    </td>
                    <td className="pt-details" title={details}>
                      {details || "-"}
                    </td>
                    <td>{a.ip ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
