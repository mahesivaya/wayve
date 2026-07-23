import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Task, TaskPriority } from "../api/tasks";
import {
  getTickets,
  updateTicketApi,
  deleteTicketApi,
  aiFixTicket,
  getAiFixState,
  commitAiFix,
  pushAiFix,
  openAiFixPr,
  type AiFixState,
} from "../api/tickets";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
import "./ticketDetail.css";

const PRIORITIES: TaskPriority[] = [1, 2, 3, 4, 5];

// Classify one unified-diff line for colouring. Order matters: the +++/---
// file headers must be caught before the +/- added/removed lines.
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "is-meta";
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "is-meta";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return "";
}

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
  const [aiFixBusy, setAiFixBusy] = useState(false);
  const [aiFixMsg, setAiFixMsg] = useState("");
  const [aiFix, setAiFix] = useState<AiFixState | null>(null);
  const [stepBusy, setStepBusy] = useState<"commit" | "push" | "pr" | null>(
    null
  );

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

  // The AI-fix review state (diff / PR). The GET is manager-only, so for anyone
  // who can't run the fixer it simply resolves to null and no AI UI is shown.
  const loadAiFix = useCallback(async () => {
    if (!Number.isFinite(ticketId)) return;
    try {
      setAiFix(await getAiFixState(ticketId));
    } catch {
      setAiFix(null);
    }
  }, [ticketId]);

  useEffect(() => {
    void loadAiFix();
  }, [loadAiFix]);

  // While CI is running, poll for the diff to land.
  useEffect(() => {
    if (aiFix?.status !== "running") return;
    const timer = window.setInterval(() => void loadAiFix(), 8000);
    return () => window.clearInterval(timer);
  }, [aiFix?.status, loadAiFix]);

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

  const runAiFix = async () => {
    if (!ticket) return;
    setAiFixBusy(true);
    setAiFixMsg("");
    try {
      const r = await aiFixTicket(ticket.id);
      setAiFixMsg(
        r.reused_fix_from
          ? `Fix started in CI (reusing the fix from #${r.reused_fix_from}). The diff will appear here to review.`
          : "Fix started in CI. The diff will appear here to review."
      );
      // Reflect the running state immediately and start polling for the diff.
      setAiFix({
        status: "running",
        diff: null,
        commit_sha: null,
        branch: null,
        pr_url: null,
      });
    } catch (err) {
      setAiFixMsg(
        err instanceof Error ? err.message : "Couldn't start the AI fix."
      );
    } finally {
      setAiFixBusy(false);
    }
  };

  // The three GitHub steps, each gated on the prior one's status. `step` runs the
  // API call and folds the returned field + new status into the local state.
  const runStep = async (
    step: "commit" | "push" | "pr",
    fn: () => Promise<Partial<AiFixState>>,
    nextStatus: AiFixState["status"],
    failMsg: string
  ) => {
    if (!ticket) return;
    setStepBusy(step);
    setAiFixMsg("");
    try {
      const patch = await fn();
      setAiFix((prev) =>
        prev ? { ...prev, ...patch, status: nextStatus } : prev
      );
    } catch (err) {
      setAiFixMsg(err instanceof Error ? err.message : failMsg);
    } finally {
      setStepBusy(null);
    }
  };

  const doCommit = () =>
    runStep(
      "commit",
      async () => ({ commit_sha: (await commitAiFix(ticket!.id)).commit_sha }),
      "committed",
      "Couldn't create the commit."
    );
  const doPush = () =>
    runStep(
      "push",
      async () => ({ branch: (await pushAiFix(ticket!.id)).branch }),
      "pushed",
      "Couldn't push the branch."
    );
  const doCreatePr = () =>
    runStep(
      "pr",
      async () => ({ pr_url: (await openAiFixPr(ticket!.id)).pr_url }),
      "pr_opened",
      "Couldn't open the pull request."
    );

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
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              {/* AI fix is limited to P5 tickets; shown only when there's no fix
                  in flight — i.e. nothing yet, or the last run gave nothing to
                  review (backend enforces the P5 gate too). */}
              {priority === 5 &&
                (!aiFix?.status ||
                  aiFix.status === "no_change" ||
                  aiFix.status === "error") && (
                  <button
                    type="button"
                    className="ticket-detail-aifix"
                    onClick={() => void runAiFix()}
                    disabled={aiFixBusy}
                  >
                    {aiFixBusy
                      ? "Starting…"
                      : aiFix?.status === "no_change" ||
                          aiFix?.status === "error"
                        ? "Retry AI fix"
                        : "Fix with AI"}
                  </button>
                )}
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
            {aiFixMsg && (
              <p className="ticket-detail-msg" role="status">
                {aiFixMsg}
              </p>
            )}
          </form>

          {/* AI-fix review panel: Claude's diff, then Commit → Push → Create PR. */}
          {aiFix?.status && (
            <section className="ticket-aifix" aria-label="AI fix">
              <h2 className="ticket-aifix-head">AI fix</h2>

              {aiFix.status === "running" && (
                <p className="ticket-aifix-muted">
                  🤖 Claude is implementing and verifying a fix in CI. The diff
                  will appear here for review when it’s ready — this can take a
                  few minutes.
                </p>
              )}

              {aiFix.status === "no_change" && (
                <p className="ticket-aifix-muted">
                  🤖 Claude ran but proposed no code change — it couldn’t find a
                  concrete fix for this ticket in the codebase. This usually
                  means the ticket doesn’t map to an actual bug in an existing
                  feature. Refine the description with the affected feature or
                  file, the expected vs. actual behaviour, and steps to
                  reproduce, then retry above.
                </p>
              )}

              {aiFix.status === "error" && (
                <p className="ticket-aifix-muted">
                  The AI fix run didn’t complete — Claude may have run out of
                  steps before finding a fix, which often happens when the
                  ticket doesn’t map to real code to change. Refine the
                  description with the affected feature or file and steps to
                  reproduce, then retry above.
                </p>
              )}

              {(aiFix.status === "ready" ||
                aiFix.status === "committed" ||
                aiFix.status === "pushed" ||
                aiFix.status === "pr_opened") &&
                (() => {
                  // How far the change has progressed; each button is active at
                  // its own step and shows a check once the step is behind us.
                  const order = {
                    ready: 0,
                    committed: 1,
                    pushed: 2,
                    pr_opened: 3,
                  }[aiFix.status];
                  return (
                    <>
                      <p className="ticket-aifix-muted">
                        Review Claude’s proposed change, then commit → push →
                        create the pull request.
                      </p>
                      <pre className="ticket-aifix-diff">
                        <code>
                          {(aiFix.diff ?? "").split("\n").map((line, i) => (
                            <span
                              key={i}
                              className={`ticket-aifix-line ${diffLineClass(
                                line
                              )}`}
                            >
                              {line || " "}
                              {"\n"}
                            </span>
                          ))}
                        </code>
                      </pre>
                      <div className="ticket-aifix-steps">
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void doCommit()}
                          disabled={stepBusy !== null || order >= 1}
                        >
                          {stepBusy === "commit"
                            ? "Committing…"
                            : order >= 1
                              ? "✓ Committed"
                              : "Commit"}
                        </button>
                        <span className="ticket-aifix-arrow" aria-hidden="true">
                          →
                        </span>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void doPush()}
                          disabled={stepBusy !== null || order < 1 || order >= 2}
                        >
                          {stepBusy === "push"
                            ? "Pushing…"
                            : order >= 2
                              ? "✓ Pushed"
                              : "Push"}
                        </button>
                        <span className="ticket-aifix-arrow" aria-hidden="true">
                          →
                        </span>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void doCreatePr()}
                          disabled={stepBusy !== null || order < 2 || order >= 3}
                        >
                          {stepBusy === "pr"
                            ? "Opening PR…"
                            : order >= 3
                              ? "✓ PR opened"
                              : "Create PR"}
                        </button>
                      </div>
                      {order >= 2 && aiFix.branch && (
                        <p className="ticket-aifix-muted">
                          Branch <code>{aiFix.branch}</code>
                          {aiFix.commit_sha && (
                            <>
                              {" · commit "}
                              <code>{aiFix.commit_sha.slice(0, 7)}</code>
                            </>
                          )}
                        </p>
                      )}
                      {aiFix.status === "pr_opened" && aiFix.pr_url && (
                        <p className="ticket-aifix-muted">
                          ✅ Pull request opened —{" "}
                          <a
                            href={aiFix.pr_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            view on GitHub
                          </a>
                          . CI must pass before it can merge.
                        </p>
                      )}
                    </>
                  );
                })()}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
