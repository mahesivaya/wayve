import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  formatUserActionDetails,
  listRegistrationTypes,
  listUserActions,
  type RegistrationTypeRow,
  type UserActionRow,
} from "../api/audit";
import { fmtDateTime } from "../utils/datetime";

// Maps users.auth_provider to a friendly label + pill style for the
// "Registration types" table.
const REGISTRATION_PROVIDERS: Record<string, { label: string; pill: string }> =
  {
    google: { label: "Gmail (Google)", pill: "provider-google" },
    microsoft: { label: "Outlook (Microsoft)", pill: "provider-microsoft" },
    local: { label: "Email registration", pill: "provider-local" },
  };

function registrationProvider(provider: string) {
  return (
    REGISTRATION_PROVIDERS[provider] ?? {
      label: provider,
      pill: "provider-local",
    }
  );
}
import { useResizableColumns } from "./useResizableColumns";
import "./platformTeam.css";

// Drag-resizable columns, in render order. Persisted under USER_LOGS_COL_WIDTHS.
const USER_LOG_COLUMNS = [
  { key: "when", label: "When", width: 150, min: 110 },
  { key: "actor", label: "Actor", width: 200, min: 100 },
  { key: "action", label: "Action", width: 140, min: 90 },
  { key: "resource", label: "Resource", width: 160, min: 90 },
  { key: "details", label: "Details", width: 320, min: 120 },
  { key: "ip", label: "IP", width: 130, min: 90 },
  { key: "location", label: "Location", width: 180, min: 110 },
] as const;

const USER_LOGS_COL_WIDTHS_KEY = "rwayve.platformUserLogs.colWidths";

// Security-relevant user actions (sign-in/out, password changes, deletions,
// file downloads/exports, billing changes) from the audit_logs table. Mirrors
// logs/user_actions.log. Scoped by the backend: platform staff see everyone.
export default function PlatformUserLogs() {
  const { user } = useAuth();
  // Owner-only: even super_admin / security (who hold audit:read) are excluded.
  const canView =
    user?.scope === "platform" && user?.effective_role === "owner";

  const [rows, setRows] = useState<UserActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [registrations, setRegistrations] = useState<RegistrationTypeRow[]>([]);
  const [registrationsLoaded, setRegistrationsLoaded] = useState(false);

  const { colWidths, totalWidth, startResize } = useResizableColumns(
    USER_LOG_COLUMNS,
    USER_LOGS_COL_WIDTHS_KEY
  );

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

  const loadRegistrations = useCallback(async () => {
    if (!canView) {
      setRegistrationsLoaded(true);
      return;
    }
    try {
      setRegistrations(await listRegistrationTypes({ limit: 500 }));
    } catch {
      // Best effort — the registration table just shows its empty state.
    } finally {
      setRegistrationsLoaded(true);
    }
  }, [canView]);

  useEffect(() => {
    void load();
    void loadRegistrations();
  }, [load, loadRegistrations]);

  const registrationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of registrations) {
      const key = r.auth_provider || "local";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [registrations]);

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
      ].some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [rows, search]);

  if (!canView) return <Navigate to="/home" replace />;

  return (
    <div className="pt-page pt-userlogs">
      <header className="pt-header">
        <h1>User Logs</h1>
        <p>
          User actions across the platform — sign-ins, email sent/received,
          password changes, role changes, deletions, exports and billing changes
          · {user?.email}
        </p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-panel pt-userlogs-reg">
        <div className="pt-panel-head">
          <h2>Registration types</h2>
          <div className="pt-reg-summary">
            {(["google", "microsoft", "local"] as const).map((p) => (
              <span
                key={p}
                className={`pt-pill ${registrationProvider(p).pill}`}
              >
                {registrationProvider(p).label}: {registrationCounts[p] ?? 0}
              </span>
            ))}
          </div>
        </div>

        {!registrationsLoaded ? (
          <div className="pt-empty">Loading…</div>
        ) : registrations.length === 0 ? (
          <div className="pt-empty">No registered users yet.</div>
        ) : (
          <div className="pt-table-scroll">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Registered via</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => {
                  const provider = registrationProvider(
                    r.auth_provider || "local"
                  );
                  return (
                    <tr key={r.id}>
                      <td>{r.email}</td>
                      <td>
                        <span className={`pt-pill ${provider.pill}`}>
                          {provider.label}
                        </span>
                      </td>
                      <td>{r.created_at ? fmtDateTime(r.created_at) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="pt-panel pt-userlogs-activity">
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
          <div className="pt-table-scroll">
            <table
              className="pt-table"
              style={{ tableLayout: "fixed", width: `${totalWidth}px` }}
            >
              <colgroup>
                {USER_LOG_COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: `${colWidths[c.key]}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {USER_LOG_COLUMNS.map((c) => (
                    <th key={c.key} className="pt-th-resizable">
                      {c.label}
                      <span
                        className="pt-col-resize-handle"
                        onMouseDown={startResize(c.key, c.min)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${c.label} column`}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const details = formatUserActionDetails(a);
                  const location = [a.city, a.region, a.country]
                    .filter(Boolean)
                    .join(", ");
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
                      <td className="pt-loc" title={location}>
                        {location || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
