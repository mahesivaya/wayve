import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  adminDecideAccessRequest,
  adminListAccessRequests,
  getAccessRequestHistory,
  type AccessHistoryEntry,
  type AccessRequestView,
} from "../api/accessRequests";
import { homePathForUser } from "../auth/accountHome";
import { fmtDateTime } from "../utils/datetime";
import "../platformTeam/platformTeam.css";

type StatusFilter = "pending" | "approved" | "denied" | "";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "", label: "All statuses" },
];

// Support review queue for access requests. The list/decide endpoints scope
// by the caller's role context server-side, so this one page serves both
// platform support (personal users' requests) and organization support (their
// own org's requests).
export default function AccessRequestsReview() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "tickets:manage");

  const [rows, setRows] = useState<AccessRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const [history, setHistory] = useState<AccessHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState("");

  const load = useCallback(async () => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    setError("");
    setLoading(true);
    try {
      setRows(await adminListAccessRequests(statusFilter || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load requests");
    } finally {
      setLoading(false);
    }
  }, [canManage, statusFilter]);

  const loadHistory = useCallback(async () => {
    if (!canManage) return;
    setHistoryError("");
    try {
      setHistory(await getAccessRequestHistory());
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load history"
      );
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const decide = async (id: number, status: "approved" | "denied") => {
    setError("");
    setBusyId(id);
    try {
      await adminDecideAccessRequest(
        id,
        status,
        notes[id]?.trim() || undefined
      );
      await Promise.all([load(), loadHistory()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update request");
    } finally {
      setBusyId(null);
    }
  };

  if (!canManage) return <Navigate to={homePathForUser(user)} replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Access Requests</h1>
        <p>
          Requests to view locked data, routed to your support team ·{" "}
          {user?.email}
        </p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Queue</h2>
          <span className="pt-stat-sub">
            Approve or deny with an explanation the requester will see
          </span>
          <select
            className="pt-filter-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="pt-empty">Loading requests…</div>
        ) : rows.length === 0 ? (
          <div className="pt-empty">
            {statusFilter
              ? `No ${statusFilter} requests right now.`
              : "No access requests yet."}
          </div>
        ) : (
          <table className="pt-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Requester</th>
                <th>Resource</th>
                <th>Explanation</th>
                <th>Created</th>
                <th>Status</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>#{r.id}</td>
                  <td>
                    {r.user_email ?? "(deleted)"}
                    {r.organization_name && (
                      <>
                        <br />
                        <small style={{ color: "#6b7280" }}>
                          {r.organization_name}
                        </small>
                      </>
                    )}
                  </td>
                  <td>{r.resource}</td>
                  <td>
                    {r.request_note || (
                      <small style={{ color: "#6b7280" }}>—</small>
                    )}
                  </td>
                  <td>{fmtDateTime(r.created_at)}</td>
                  <td>
                    <span className="pt-pill info">{r.status}</span>
                    {r.decision_note && (
                      <>
                        <br />
                        <small style={{ color: "#6b7280" }}>
                          {r.decision_note}
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    <textarea
                      rows={2}
                      placeholder="Explanation (optional)"
                      value={notes[r.id] ?? ""}
                      onChange={(e) =>
                        setNotes((prev) => ({
                          ...prev,
                          [r.id]: e.target.value,
                        }))
                      }
                      style={{ width: 180, display: "block", marginBottom: 6 }}
                    />
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r.id, "approved")}
                      style={{ marginRight: 6 }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void decide(r.id, "denied")}
                    >
                      Deny
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>History</h2>
          <span className="pt-stat-sub">
            Audit trail of every request, approval and denial for your team
          </span>
          <button
            type="button"
            className="pt-filter-select"
            onClick={() => void loadHistory()}
          >
            Refresh
          </button>
        </div>

        {historyError && <div className="pt-banner">{historyError}</div>}

        {history.length === 0 ? (
          <div className="pt-empty">No activity logged yet.</div>
        ) : (
          <table className="pt-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Requester</th>
                <th>By</th>
                <th>Resource</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.request_id}-${h.ts}-${i}`}>
                  <td>{fmtDateTime(h.ts)}</td>
                  <td>
                    <span className="pt-pill info">{h.event}</span>
                  </td>
                  <td>{h.requester_email ?? "—"}</td>
                  <td>{h.actor_email ?? "—"}</td>
                  <td>{h.resource}</td>
                  <td>
                    {h.note || <small style={{ color: "#6b7280" }}>—</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
