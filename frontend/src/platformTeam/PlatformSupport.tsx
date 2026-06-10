import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { SupportSummary, getSupportSummary } from "../api/platformTeam";
import {
  adminListTickets,
  adminUpdateTicketStatus,
  type SupportTicket,
  type TicketStatus,
} from "../api/support";
import { fmtDate, fmtDateTime } from "../utils/datetime";
import "./platformTeam.css";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

export default function PlatformSupport() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" && hasPermission(user, "members:read");
  const canManageTickets = hasPermission(user, "tickets:manage");

  const [data, setData] = useState<SupportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [ticketsError, setTicketsError] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "">("open");
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      setData(await getSupportSummary());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load support summary"
      );
    } finally {
      setLoading(false);
    }
  }, [canView]);

  const loadTickets = useCallback(async () => {
    if (!canManageTickets) {
      setTicketsLoading(false);
      return;
    }
    setTicketsError("");
    setTicketsLoading(true);
    try {
      const rows = await adminListTickets(statusFilter || undefined);
      setTickets(rows);
    } catch (err) {
      setTicketsError(
        err instanceof Error ? err.message : "Failed to load tickets"
      );
    } finally {
      setTicketsLoading(false);
    }
  }, [canManageTickets, statusFilter]);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const setTicketStatus = async (id: number, status: TicketStatus) => {
    setUpdatingId(id);
    try {
      await adminUpdateTicketStatus(id, status);
      // Re-fetch so the filter view stays correct (a resolved ticket leaves
      // the "open" list once the user changes status).
      await loadTickets();
    } catch (err) {
      setTicketsError(
        err instanceof Error ? err.message : "Failed to update ticket"
      );
    } finally {
      setUpdatingId(null);
    }
  };

  if (!canView) return <Navigate to="/" replace />;
  if (loading) return <div className="pt-loader">Loading support console…</div>;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Support Console</h1>
        <p>In-app tickets and shared inbox queue · {user?.email}</p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      {canManageTickets && (
        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Support tickets</h2>
            <span className="pt-stat-sub">
              In-app issues raised by users and organizations
            </span>
            <select
              className="pt-filter-select"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as TicketStatus | "")
              }
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {ticketsError && <div className="pt-banner">{ticketsError}</div>}
          {ticketsLoading ? (
            <div className="pt-empty">Loading tickets…</div>
          ) : tickets.length === 0 ? (
            <div className="pt-empty">
              {statusFilter
                ? `No ${statusFilter.replace("_", " ")} tickets right now.`
                : "No tickets yet."}
            </div>
          ) : (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subject</th>
                  <th>Reporter</th>
                  <th>Category</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td>#{t.id}</td>
                    <td>
                      <strong>{t.subject}</strong>
                      <br />
                      <small style={{ color: "#6b7280" }}>
                        {t.description.length > 140
                          ? `${t.description.slice(0, 140)}…`
                          : t.description}
                        {t.attachment_count > 0 &&
                          ` · 📎 ${t.attachment_count}`}
                      </small>
                    </td>
                    <td>
                      {t.user_email ?? "(deleted)"}
                      {t.organization_name && (
                        <>
                          <br />
                          <small style={{ color: "#6b7280" }}>
                            {t.organization_name}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      <span className="pt-pill info">{t.category}</span>
                    </td>
                    <td>{fmtDateTime(t.created_at)}</td>
                    <td>
                      <select
                        value={t.status}
                        disabled={updatingId === t.id}
                        onChange={(e) =>
                          void setTicketStatus(
                            t.id,
                            e.target.value as TicketStatus
                          )
                        }
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Open shared-inbox threads</h2>
          <span className="pt-stat-sub">
            Tickets needing a response across customer mailboxes
          </span>
        </div>
        {data && data.open_inbox_queue.length > 0 ? (
          <table className="pt-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Mailbox</th>
                <th>Assignee</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.open_inbox_queue.map((row) => (
                <tr key={row.email_id}>
                  <td>{row.subject ?? "(no subject)"}</td>
                  <td>{row.inbox_email ?? "—"}</td>
                  <td>{row.assignee_email ?? "Unassigned"}</td>
                  <td>
                    <span className={`pt-pill ${row.status}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{fmtDate(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="pt-empty">
            All shared inboxes are clear. Nothing waiting on you right now.
          </div>
        )}
      </section>
    </div>
  );
}
