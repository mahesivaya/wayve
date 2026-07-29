import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Task, TaskPriority } from "../api/tasks";
import {
  getTickets,
  updateTicketApi,
  deleteTicketApi,
} from "../api/tickets";
import { ticketAiFix } from "../api/aiFix";
import AiFixPanel from "../aifix/AiFixPanel";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
import "./ticketDetail.css";

const PRIORITIES: TaskPriority[] = [1, 2, 3, 4, 5];

// The AI fixer is limited to the low-stakes end of the scale — P4 (Low) and
// P5 (Lowest). The backend enforces the same gate.
const AI_FIX_MIN_PRIORITY = 4;

// Full-page editable view of a single ticket — the Tickets board routes here
// (config.detailPath) instead of opening the edit modal. Reuses the same ticket
// + status APIs; edits go through updateTicketApi, so behaviour matches the board.
export default function TicketDetail() {
  const { id } = useParams();
  const ticketId = Number(id);
  const navigate = useNavigate();

  const [ticket, setTicket] = useState<Task | null>(null);
  const [statuses, setStatuses] = useState<TaskStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");

  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [list, sts] = await Promise.all([getTickets(), getTaskStatuses()]);
      setStatuses(sts);
      const found = list.find((t) => t.id === ticketId);
      if (!found) {
        setTicket(null);
        setLoadError("Ticket not found.");
        return;
      }
      setTicket(found);
      setName(found.name);
      setDescription(found.description);
      setPriority((found.priority as TaskPriority) ?? 3);
      setStatus(found.status);
      setAssignee(found.assignee ?? "");
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load ticket."
      );
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!ticket) return;
    if (!name.trim()) {
      setStatusMsg("Name is required.");
      return;
    }
    setSaving(true);
    setStatusMsg("");
    try {
      const updated = await updateTicketApi(ticket.id, {
        name: name.trim(),
        description,
        priority,
        status,
        assigned_by: ticket.assigned_by,
        assignee,
        assignee_id: ticket.assignee_id ?? null,
        project_id: ticket.project_id ?? null,
      });
      setTicket(updated);
      setStatusMsg("Saved.");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  // Save is gated on the form actually differing from the ticket it loaded, so
  // an untouched page can't post a no-op update. `setTicket(updated)` on a
  // successful save re-baselines this, which disables the button again. Name is
  // compared trimmed because `save` trims it — trailing whitespace is not an
  // edit.
  const dirty =
    ticket !== null &&
    (name.trim() !== ticket.name ||
      description !== ticket.description ||
      priority !== ((ticket.priority as TaskPriority) ?? 3) ||
      status !== ticket.status ||
      assignee !== (ticket.assignee ?? ""));

  const remove = async () => {
    if (!ticket) return;
    if (
      !window.confirm(`Delete ticket "${ticket.name}"? This can't be undone.`)
    )
      return;
    try {
      await deleteTicketApi(ticket.id);
      navigate("/tickets");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Delete failed.");
    }
  };


  return (
    <div className="ticket-detail">
      <button
        type="button"
        className="ticket-detail-back"
        onClick={() => navigate("/tickets")}
      >
        ← Back to Tickets
      </button>

      {loading ? (
        <p className="ticket-detail-muted">Loading ticket…</p>
      ) : loadError ? (
        <div className="ticket-detail-error">
          <strong>{loadError}</strong>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : ticket ? (
        <>
          <div className="ticket-detail-head">
            {ticket.task_number != null && (
              <span className="ticket-detail-key">#{ticket.task_number}</span>
            )}
            <h1>{name || "Untitled ticket"}</h1>
          </div>

          <form
            className="ticket-detail-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              <span>Title</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ticket title"
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
              />
            </label>
            <div className="ticket-detail-row">
              <label>
                <span>Priority</span>
                <select
                  value={priority}
                  onChange={(e) =>
                    setPriority(Number(e.target.value) as TaskPriority)
                  }
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      P{p}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {statuses.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Assignee</span>
                <input
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder="Unassigned"
                />
              </label>
            </div>

            <div className="ticket-detail-actions">
              <button
                type="submit"
                className="primary"
                disabled={saving || !dirty}
                title={dirty ? undefined : "No changes to save"}
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
              {/* "Fix with AI" now lives in the AI-fix panel below, beside the
                  diff it produces. */}
              <button
                type="button"
                className="ticket-detail-delete"
                onClick={() => void remove()}
              >
                Delete
              </button>
              {statusMsg && (
                <span className="ticket-detail-msg" role="status">
                  {statusMsg}
                </span>
              )}
            </div>
          </form>

          {/* AI-fix review: the diff, an editor for the proposed files, then
              Commit → Push → Create PR. Owns its own "Fix with AI" button. */}
          <AiFixPanel
            itemId={ticket.id}
            api={ticketAiFix}
            canFix={priority >= AI_FIX_MIN_PRIORITY}
            kind="ticket"
          />
        </>
      ) : null}
    </div>
  );
}
