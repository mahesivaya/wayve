// Task statuses management, grouped by the fixed category axis.
//
// Read access is open to anyone in the scope (the task board needs the list), so
// this page renders read-only for members and unlocks the editing affordances
// only for holders of `task_statuses:manage`. That mirrors the backend, which
// gates the write endpoints on the same permission — this gate is UI polish, not
// authorization.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  CATEGORY_LABEL,
  STATUS_CATEGORIES,
  createTaskStatus,
  deleteTaskStatus,
  getTaskStatuses,
  reorderTaskStatuses,
  updateTaskStatus,
  type StatusCategory,
  type TaskStatusRow,
} from "../api/taskStatuses";
import TaskStatusIcon from "../tasks/TaskStatusIcon";
import SettingsShell from "../profile/SettingsShell";
import "./taskStatuses.css";

// Offered in the colour picker. Deliberately a fixed set rather than a free
// <input type="color">: statuses sit next to each other on the board, so a
// curated palette keeps them mutually distinguishable and readable on both the
// light and dark surfaces.
const SWATCHES = [
  "#6b7280",
  "#4c9aff",
  "#36b37e",
  "#f5a623",
  "#e5484d",
  "#8b5cf6",
  "#ec4899",
  "#0ea5e9",
  "#14b8a6",
  "#a16207",
];

type DraftState = {
  name: string;
  description: string;
  color: string;
};

const emptyDraft = (color = SWATCHES[0]): DraftState => ({
  name: "",
  description: "",
  color,
});

function ColorPicker({
  value,
  category,
  onChange,
  disabled,
}: {
  value: string;
  category: StatusCategory;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="ts-color">
      <button
        type="button"
        className="ts-color-button"
        style={{ backgroundColor: `${value}22` }}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label="Choose status color"
        aria-expanded={open}
      >
        <TaskStatusIcon category={category} color={value} size={16} />
      </button>
      {open && (
        <span className="ts-color-menu" role="listbox">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="option"
              aria-selected={swatch === value}
              aria-label={swatch}
              className={`ts-swatch${swatch === value ? " ts-swatch--on" : ""}`}
              style={{ backgroundColor: swatch }}
              onClick={() => {
                onChange(swatch);
                setOpen(false);
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

export default function TaskStatuses() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "task_statuses:manage");
  // Owners of an org/platform scope can elevate; personal accounts and plain
  // members cannot, and get the "ask an admin" wording instead.
  const canSwitchAdmin =
    user?.mode !== "admin" && (user?.can_switch_admin ?? false);

  const [statuses, setStatuses] = useState<TaskStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Which category currently has its inline create row open, and its draft.
  const [creatingIn, setCreatingIn] = useState<StatusCategory | null>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());

  // The status being edited inline, and its draft.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<DraftState>(emptyDraft());

  const [dragId, setDragId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setError("");
    try {
      setStatuses(await getTaskStatuses());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load task statuses"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byCategory = useMemo(() => {
    const groups = new Map<StatusCategory, TaskStatusRow[]>();
    for (const category of STATUS_CATEGORIES) groups.set(category, []);
    for (const status of statuses) {
      groups.get(status.category)?.push(status);
    }
    return groups;
  }, [statuses]);

  const openCreate = (category: StatusCategory) => {
    setEditingId(null);
    setCreatingIn(category);
    setDraft(emptyDraft());
  };

  const submitCreate = async (category: StatusCategory) => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await createTaskStatus({
        name: draft.name.trim(),
        category,
        description: draft.description.trim(),
        color: draft.color,
      });
      setCreatingIn(null);
      setDraft(emptyDraft());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create status");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (status: TaskStatusRow) => {
    setCreatingIn(null);
    setEditingId(status.id);
    setEditDraft({
      name: status.name,
      description: status.description,
      color: status.color,
    });
  };

  // Save is gated on the row's draft differing from the status it opened, so an
  // inline edit that changes nothing can't post a no-op update. Name and
  // description compare trimmed, matching what `submitEdit` sends.
  const editDirty = (status: TaskStatusRow) =>
    editDraft.name.trim() !== status.name ||
    editDraft.description.trim() !== status.description ||
    editDraft.color !== status.color;

  const submitEdit = async (status: TaskStatusRow) => {
    if (!editDraft.name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await updateTaskStatus(status.id, {
        name: editDraft.name.trim(),
        category: status.category,
        description: editDraft.description.trim(),
        color: editDraft.color,
      });
      setEditingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Recolour straight from the row's swatch, without entering edit mode.
   *
   * The coloured chip reads as the colour control — it's the affordance the
   * reference design uses — so leaving it inert meant the only way to recolour
   * was to notice "Edit", change the colour, then "Save". Clicking the chip now
   * picks the colour and saves it immediately; name and description still go
   * through the edit row, which is where they belong.
   */
  const recolor = async (status: TaskStatusRow, color: string) => {
    if (busy || color === status.color) return;
    setBusy(true);
    setError("");
    // Optimistic, so the swatch updates under the cursor instead of after the
    // round-trip; reload() below reconciles with the server.
    setStatuses((prev) =>
      prev.map((s) => (s.id === status.id ? { ...s, color } : s))
    );
    try {
      await updateTaskStatus(status.id, {
        name: status.name,
        category: status.category,
        description: status.description,
        color,
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update color");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  // Deleting a status with tasks on it needs somewhere for those tasks to go.
  // Rather than fail and make the user guess, ask for the destination up front
  // and pass it through — the backend rejects the delete without one.
  const remove = async (status: TaskStatusRow) => {
    if (busy) return;
    let reassignTo: string | undefined;

    if (status.task_count > 0) {
      const options = statuses.filter((s) => s.id !== status.id);
      if (options.length === 0) return;
      const answer = window.prompt(
        `${status.task_count} task(s) use "${status.name}". ` +
          `Type the status to move them to:\n\n` +
          options.map((s) => `  ${s.name}`).join("\n"),
        options[0].name
      );
      if (answer === null) return;
      const match = options.find(
        (s) => s.name.toLowerCase() === answer.trim().toLowerCase()
      );
      if (!match) {
        setError(`No status named "${answer}". Nothing was deleted.`);
        return;
      }
      reassignTo = match.slug;
    } else if (!window.confirm(`Delete the "${status.name}" status?`)) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      await deleteTaskStatus(status.id, reassignTo);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete status");
    } finally {
      setBusy(false);
    }
  };

  // Drag-reorder. Dropping onto a row splices the dragged status in at that
  // row's index and persists the whole order, so positions stay dense.
  const onDrop = async (targetId: number) => {
    if (dragId === null || dragId === targetId) return;
    const order = statuses.map((s) => s.id);
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;

    order.splice(to, 0, ...order.splice(from, 1));
    setDragId(null);

    // Optimistic: reorder locally so the row lands where it was dropped, then
    // reconcile with whatever the server returns.
    setStatuses(
      (prev) =>
        order
          .map((id) => prev.find((s) => s.id === id))
          .filter(Boolean) as TaskStatusRow[]
    );
    try {
      setStatuses(await reorderTaskStatuses(order));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder");
      await reload();
    }
  };

  return (
    <SettingsShell title="Task statuses">
      <div className="ts-page">
        <p className="ts-subtitle">
          Task statuses define the workflow that tasks go through from start to
          completion.
        </p>

        {error && (
          <div className="ts-error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className="ts-muted">Loading…</p>
        ) : (
          <div className="ts-card">
            {STATUS_CATEGORIES.map((category) => {
              const rows = byCategory.get(category) ?? [];
              return (
                <section key={category} className="ts-group">
                  <header className="ts-group-head">
                    <h2 className="ts-group-title">
                      {CATEGORY_LABEL[category]}
                    </h2>
                    {canManage && (
                      <button
                        type="button"
                        className="ts-add"
                        onClick={() => openCreate(category)}
                        aria-label={`Add a status to ${CATEGORY_LABEL[category]}`}
                      >
                        +
                      </button>
                    )}
                  </header>

                  {rows.map((status) =>
                    editingId === status.id ? (
                      <form
                        key={status.id}
                        className="ts-row ts-row--form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submitEdit(status);
                        }}
                      >
                        <span className="ts-handle" aria-hidden="true">
                          ⠿
                        </span>
                        <ColorPicker
                          value={editDraft.color}
                          category={status.category}
                          onChange={(color) =>
                            setEditDraft((d) => ({ ...d, color }))
                          }
                        />
                        <input
                          className="ts-input"
                          placeholder="Name"
                          aria-label="Status name"
                          value={editDraft.name}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              name: e.target.value,
                            }))
                          }
                        />
                        <input
                          className="ts-input ts-input--desc"
                          placeholder="Description…"
                          aria-label="Status description"
                          value={editDraft.description}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              description: e.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="ts-btn ts-btn--ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="ts-btn ts-btn--primary"
                          disabled={
                            busy || !editDraft.name.trim() || !editDirty(status)
                          }
                          title={
                            editDirty(status) ? undefined : "No changes to save"
                          }
                        >
                          Save
                        </button>
                      </form>
                    ) : (
                      <div
                        key={status.id}
                        className={`ts-row${dragId === status.id ? " ts-row--dragging" : ""}`}
                        draggable={canManage}
                        onDragStart={() => setDragId(status.id)}
                        onDragEnd={() => setDragId(null)}
                        onDragOver={(e) => {
                          if (canManage) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          void onDrop(status.id);
                        }}
                      >
                        {canManage && (
                          <span className="ts-handle" aria-hidden="true">
                            ⠿
                          </span>
                        )}
                        {canManage ? (
                          <ColorPicker
                            value={status.color}
                            category={status.category}
                            onChange={(color) => void recolor(status, color)}
                          />
                        ) : (
                          <span
                            className="ts-chip"
                            style={{ backgroundColor: `${status.color}22` }}
                          >
                            <TaskStatusIcon
                              category={status.category}
                              color={status.color}
                              size={16}
                            />
                          </span>
                        )}
                        <span className="ts-meta">
                          <span className="ts-name">{status.name}</span>
                          <span className="ts-sub">
                            {status.description ||
                              `${status.task_count} ${
                                status.task_count === 1 ? "task" : "tasks"
                              }`}
                          </span>
                        </span>
                        {canManage && (
                          <span className="ts-actions">
                            <button
                              type="button"
                              className="ts-btn ts-btn--ghost"
                              onClick={() => openEdit(status)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="ts-btn ts-btn--danger"
                              onClick={() => void remove(status)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          </span>
                        )}
                      </div>
                    )
                  )}

                  {creatingIn === category && (
                    <form
                      className="ts-row ts-row--form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submitCreate(category);
                      }}
                    >
                      <span className="ts-handle" aria-hidden="true">
                        ⠿
                      </span>
                      <ColorPicker
                        value={draft.color}
                        category={category}
                        onChange={(color) => setDraft((d) => ({ ...d, color }))}
                      />
                      <input
                        className="ts-input"
                        placeholder="Name"
                        aria-label="New status name"
                        autoFocus
                        value={draft.name}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, name: e.target.value }))
                        }
                      />
                      <input
                        className="ts-input ts-input--desc"
                        placeholder="Description…"
                        aria-label="New status description"
                        value={draft.description}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            description: e.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="ts-btn ts-btn--ghost"
                        onClick={() => setCreatingIn(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="ts-btn ts-btn--primary"
                        disabled={busy || !draft.name.trim()}
                      >
                        Create
                      </button>
                    </form>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {/* An org/platform owner browsing in normal session mode is downscoped
            to `member` and lands here read-only, so "ask an admin" would be
            useless advice to the very person who is one. Point at the mode
            switch when they could elevate, and at their admin otherwise. */}
        {!canManage && !loading && (
          <p className="ts-muted">
            {canSwitchAdmin
              ? "You're in normal mode, so these are read-only. Switch to admin mode to rename, recolour or reorder them."
              : "These are your organization's shared statuses. An owner or admin can change them."}
          </p>
        )}
      </div>
    </SettingsShell>
  );
}
