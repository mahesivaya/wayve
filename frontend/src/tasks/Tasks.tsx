import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createTaskApi,
  deleteTaskApi,
  deleteTaskAttachment,
  downloadTaskAttachment,
  getTasks,
  listTaskAttachments,
  updateTaskApi,
  uploadTaskAttachments,
  type Task,
  type TaskAttachment,
  type TaskPriority,
  type TaskStatus,
} from "../api/tasks";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import Modal from "../components/Modal";
import { useInSplitPane } from "../components/SplitPaneContext";
import "./tasks.css";

const PRIORITY_OPTIONS: TaskPriority[] = [5, 4, 3, 2, 1];

const priorityLabel = (priority: TaskPriority) => {
  if (priority === 5) return "Highest";
  if (priority === 4) return "High";
  if (priority === 3) return "Medium";
  if (priority === 2) return "Low";
  return "Lowest";
};

const normalizePriority = (value: unknown): TaskPriority => {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3 || n === 4 || n === 5) return n;
  return 3;
};

const normalizeStatus = (value: unknown): TaskStatus => {
  if (value === "done" || value === "in_review" || value === "in_progress") {
    return value;
  }
  return "to_do";
};

const sortTasks = (list: Task[]) =>
  [...list].sort(
    (a, b) =>
      b.priority - a.priority ||
      // Within a priority group, oldest first so a newly created task
      // appears at the bottom of its group.
      new Date(a.created_at ?? 0).getTime() -
        new Date(b.created_at ?? 0).getTime()
  );

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "to_do", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
];

export default function Tasks() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const isPersonal = user?.scope === "personal";
  // In a split pane the Tasks page collapses to a single column (Create button
  // → list) and clicking a task expands it inline (accordion) instead of
  // opening the edit modal.
  const inSplitPane = useInSplitPane();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<"list" | "grid">(() => {
    const saved = window.localStorage.getItem("wayve.tasks.view");
    return saved === "grid" ? "grid" : "list";
  });

  useEffect(() => {
    window.localStorage.setItem("wayve.tasks.view", view);
  }, [view]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [taskName, setTaskName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);
  const [status, setStatus] = useState<TaskStatus>("to_do");
  const [assignedBy, setAssignedBy] = useState("");
  const [assignee, setAssignee] = useState("");
  const [createAnother, setCreateAnother] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Files chosen in the modal but not yet uploaded. Held locally so creation
  // can persist them once we have the new task id, and so they survive
  // re-renders before submit. Reset by closeForm/resetForm.
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  // Server-side attachments for the task currently being edited.
  const [existingAttachments, setExistingAttachments] = useState<
    TaskAttachment[]
  >([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isEditing = editingId !== null;

  const loadTasks = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    try {
      const list = await getTasks();
      setTasks(
        sortTasks(
          list.map((t) => ({
            ...t,
            priority: normalizePriority(t.priority),
            status: normalizeStatus(t.status),
          }))
        )
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred to a microtask so the effect body doesn't synchronously call
  // setState — the React 19 "set-state-in-effect" rule flags the direct
  // pattern as cascading-render risk. Same wrapper as `AuditSecurity.tsx`.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks]);

  const resetForm = () => {
    setTaskName("");
    setDescription("");
    setPriority(3);
    setStatus("to_do");
    setAssignedBy("");
    setAssignee("");
    setEditingId(null);
    setError("");
    setPendingAttachments([]);
    setExistingAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeForm = () => {
    resetForm();
    setCreateAnother(false);
    setCreating(false);
  };

  const openCreate = () => {
    resetForm();
    setCreating(true);
  };

  const openEdit = (task: Task) => {
    setEditingId(task.id);
    setTaskName(task.name);
    setDescription(task.description);
    setPriority(normalizePriority(task.priority));
    setStatus(normalizeStatus(task.status));
    setAssignedBy(task.assigned_by ?? "");
    setAssignee(task.assignee ?? "");
    setError("");
    setCreateAnother(false);
    setPendingAttachments([]);
    setExistingAttachments([]);
    setCreating(true);
    setAttachmentsLoading(true);
    listTaskAttachments(task.id)
      .then((list) => setExistingAttachments(list))
      .catch(() => {
        // Non-fatal — just leave the list empty.
      })
      .finally(() => setAttachmentsLoading(false));
  };

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    const next = Array.from(list);
    if (next.length === 0) return;
    setPendingAttachments((prev) => [...prev, ...next]);
    // Reset input so the same filename can be picked again after removal.
    event.target.value = "";
  };

  const removePending = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const removeExisting = async (attachment: TaskAttachment) => {
    const ok = window.confirm(`Remove attachment "${attachment.name}"?`);
    if (!ok) return;
    try {
      await deleteTaskAttachment(attachment.id);
      setExistingAttachments((prev) =>
        prev.filter((a) => a.id !== attachment.id)
      );
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Failed to remove attachment"
      );
    }
  };

  const downloadExisting = async (attachment: TaskAttachment) => {
    try {
      await downloadTaskAttachment(attachment);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Failed to download attachment"
      );
    }
  };

  const formatBytes = (size: number) => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const changeStatus = async (task: Task, nextStatus: TaskStatus) => {
    if (task.status === nextStatus) return;
    // Optimistic flip — visual cost of a request-then-update lag is jarring
    // when the user toggles status repeatedly. We roll back on failure.
    const prev = tasks;
    setTasks((current) =>
      sortTasks(
        current.map((t) =>
          t.id === task.id ? { ...t, status: nextStatus } : t
        )
      )
    );
    try {
      const updated = await updateTaskApi(task.id, {
        name: task.name,
        description: task.description,
        priority: task.priority,
        status: nextStatus,
        assigned_by: task.assigned_by ?? "",
        assignee: task.assignee ?? "",
      });
      setTasks((current) =>
        sortTasks(
          current.map((t) =>
            t.id === updated.id
              ? {
                  ...updated,
                  priority: normalizePriority(updated.priority),
                  status: normalizeStatus(updated.status),
                }
              : t
          )
        )
      );
    } catch (err) {
      setTasks(prev);
      window.alert(
        err instanceof Error ? err.message : "Failed to update status"
      );
    }
  };

  const deleteTask = async (task: Task) => {
    const ok = window.confirm(
      `Delete task "${task.name}"? This cannot be undone.`
    );
    if (!ok) return;
    try {
      await deleteTaskApi(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      if (editingId === task.id) {
        resetForm();
        setCreating(false);
      }
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Failed to delete task"
      );
    }
  };

  const visibleTasks = useMemo(() => {
    if (!normalizedSearchQuery) return tasks;
    return tasks.filter((task) =>
      [task.name, task.description]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery)
    );
  }, [normalizedSearchQuery, tasks]);

  const activeTasks = useMemo(
    () => visibleTasks.filter((t) => t.status !== "done"),
    [visibleTasks]
  );

  const completedTasks = useMemo(
    () => visibleTasks.filter((t) => t.status === "done"),
    [visibleTasks]
  );

  const saveTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = taskName.trim();
    const details = description.trim();

    if (!name) {
      setError("Task name is required");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      let targetTaskId: number;
      if (editingId !== null) {
        const updated = await updateTaskApi(editingId, {
          name,
          description: details,
          priority,
          status,
          assigned_by: assignedBy.trim(),
          assignee: assignee.trim(),
        });
        targetTaskId = updated.id;
        setTasks((prev) =>
          sortTasks(
            prev.map((t) =>
              t.id === updated.id
                ? {
                    ...updated,
                    priority: normalizePriority(updated.priority),
                    status: normalizeStatus(updated.status),
                  }
                : t
            )
          )
        );
      } else {
        const created = await createTaskApi({
          name,
          description: details,
          priority,
          status,
          assigned_by: assignedBy.trim(),
          assignee: assignee.trim(),
        });
        targetTaskId = created.id;
        setTasks((prev) =>
          sortTasks([
            ...prev,
            {
              ...created,
              priority: normalizePriority(created.priority),
              status: normalizeStatus(created.status),
            },
          ])
        );
      }

      if (pendingAttachments.length > 0) {
        try {
          await uploadTaskAttachments(targetTaskId, pendingAttachments);
        } catch (err) {
          // Task is already saved — surface the attachment failure but
          // keep the modal open so the user can retry the upload.
          setError(
            err instanceof Error
              ? `Task saved, but attachment upload failed: ${err.message}`
              : "Task saved, but attachment upload failed"
          );
          setSubmitting(false);
          return;
        }
      }

      if (createAnother && editingId === null) {
        setTaskName("");
        setDescription("");
        setPendingAttachments([]);
        setExistingAttachments([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setError("");
      } else {
        closeForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`tasks-app${isPersonal ? " tasks-app--personal" : ""}`}>
      <main className="tasks-main">
        {inSplitPane ? (
          <button
            className="create-task-btn create-task-btn--split"
            onClick={openCreate}
          >
            + Create task
          </button>
        ) : (
          <div className="tasks-header">
            <div>
              <h2>Tasks</h2>
              <p>Create simple work items with a name and description.</p>
            </div>
            <div className="tasks-header-actions">
              <span className="tasks-count">{tasks.length} total</span>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`view-toggle-btn${view === "list" ? " active" : ""}`}
                  onClick={() => setView("list")}
                  aria-pressed={view === "list"}
                  aria-label="List view"
                  title="List view"
                >
                  ☰
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn${view === "grid" ? " active" : ""}`}
                  onClick={() => setView("grid")}
                  aria-pressed={view === "grid"}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  ▦
                </button>
              </div>
              <button
                className="create-task-btn create-task-btn--inline"
                onClick={openCreate}
              >
                + Create task
              </button>
            </div>
          </div>
        )}

        <Modal
          isOpen={creating}
          onClose={closeForm}
          title={isEditing ? "Edit Task" : "Create Task"}
        >
          <form
            className="task-create-form task-create-form--modal"
            onSubmit={saveTask}
          >
            {!isEditing && (
              <p className="task-form-required-hint">
                Required fields are marked with an asterisk{" "}
                <span className="task-form-required-mark">*</span>
              </p>
            )}

            <div className="task-form-grid">
              <label className="task-form-field">
                <span className="task-form-label">Status</span>
                <select
                  className="task-form-select"
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as TaskStatus)
                  }
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {!isEditing && (
                  <span className="task-form-hint">
                    This is the initial status upon creation
                  </span>
                )}
              </label>

              <label className="task-form-field">
                <span className="task-form-label">
                  Summary <span className="task-form-required-mark">*</span>
                </span>
                <input
                  value={taskName}
                  onChange={(event) => setTaskName(event.target.value)}
                  placeholder="Enter task summary"
                  autoFocus
                  required
                />
              </label>

              <label className="task-form-field">
                <span className="task-form-label">Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Add task details"
                />
              </label>

              {/* Task assignment (Assigned by / Assignee / Assign to me) is a
                  team feature — only business (organization) accounts see it.
                  Personal accounts are single-user, so it's hidden for them. */}
              {!isPersonal && (
                <>
                  <label className="task-form-field">
                    <span className="task-form-label">Assigned by</span>
                    <input
                      value={assignedBy}
                      onChange={(event) => setAssignedBy(event.target.value)}
                      placeholder="Who assigned this task"
                    />
                  </label>

                  <label className="task-form-field">
                    <span className="task-form-label">Assignee</span>
                    <input
                      value={assignee}
                      onChange={(event) => setAssignee(event.target.value)}
                      placeholder="Who is this task assigned to"
                    />
                    {user?.email && (
                      <span className="task-form-assign-me">
                        <input
                          type="checkbox"
                          checked={
                            assignee.trim().toLowerCase() ===
                            user.email.toLowerCase()
                          }
                          onChange={(event) =>
                            setAssignee(event.target.checked ? user.email : "")
                          }
                        />
                        Assign to me
                      </span>
                    )}
                  </label>
                </>
              )}

              <label className="task-form-field">
                <span className="task-form-label">Priority</span>
                <select
                  className="task-form-select"
                  value={priority}
                  onChange={(event) =>
                    setPriority(normalizePriority(event.target.value))
                  }
                >
                  {PRIORITY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {priorityLabel(value)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="task-form-field task-form-field--attachments">
                <span className="task-form-label">Attachments</span>
                <div className="task-attachments-controls">
                  <button
                    type="button"
                    className="task-attachments-pick"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    + Add files
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="task-attachments-input"
                    onChange={onPickFiles}
                  />
                  <span className="task-form-hint">
                    Files are uploaded when you save the task.
                  </span>
                </div>

                {isEditing && attachmentsLoading && (
                  <div className="task-attachments-empty">
                    Loading attachments…
                  </div>
                )}

                {(existingAttachments.length > 0 ||
                  pendingAttachments.length > 0) && (
                  <ul className="task-attachments-list">
                    {existingAttachments.map((att) => (
                      <li
                        key={`saved-${att.id}`}
                        className="task-attachment-item"
                      >
                        <button
                          type="button"
                          className="task-attachment-name"
                          onClick={() => void downloadExisting(att)}
                          title="Download"
                        >
                          {att.name}
                        </button>
                        <span className="task-attachment-size">
                          {formatBytes(att.size)}
                        </span>
                        <button
                          type="button"
                          className="task-attachment-remove"
                          onClick={() => void removeExisting(att)}
                          aria-label={`Remove ${att.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {pendingAttachments.map((file, idx) => (
                      <li
                        key={`pending-${idx}-${file.name}`}
                        className="task-attachment-item task-attachment-item--pending"
                      >
                        <span className="task-attachment-name task-attachment-name--pending">
                          {file.name}
                        </span>
                        <span className="task-attachment-size">
                          {formatBytes(file.size)}
                        </span>
                        <span className="task-attachment-badge">Pending</span>
                        <button
                          type="button"
                          className="task-attachment-remove"
                          onClick={() => removePending(idx)}
                          aria-label={`Remove ${file.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {error && <div className="task-error">{error}</div>}

            <div className="task-form-footer">
              {!isEditing ? (
                <label className="task-form-create-another">
                  <input
                    type="checkbox"
                    checked={createAnother}
                    onChange={(event) => setCreateAnother(event.target.checked)}
                  />
                  <span>Create another</span>
                </label>
              ) : (
                <span />
              )}
              <div className="task-form-actions">
                <button
                  type="button"
                  className="task-form-cancel"
                  disabled={submitting}
                  onClick={closeForm}
                >
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={submitting}>
                  {submitting
                    ? isEditing
                      ? "Saving…"
                      : "Creating…"
                    : isEditing
                      ? "Save changes"
                      : "Create"}
                </button>
              </div>
            </div>
          </form>
        </Modal>

        <div className={`task-list task-list--${view}`}>
          {loading ? (
            <div className="tasks-empty">
              <strong>Loading tasks…</strong>
            </div>
          ) : loadError ? (
            <div className="tasks-empty">
              <strong>Couldn&apos;t load tasks</strong>
              <span>{loadError}</span>
              <button
                type="button"
                className="task-edit-btn"
                onClick={() => void loadTasks()}
              >
                Try again
              </button>
            </div>
          ) : visibleTasks.length === 0 ? (
            <div className="tasks-empty">
              <strong>
                {tasks.length === 0 ? "No tasks yet" : "No matching tasks"}
              </strong>
              <span>
                {tasks.length === 0
                  ? "Use + Create task to add your first task."
                  : "Try a different search term."}
              </span>
            </div>
          ) : activeTasks.length === 0 ? (
            <div className="tasks-empty">
              <strong>All caught up</strong>
              <span>
                Every task is done. See the Completed tasks section below.
              </span>
            </div>
          ) : (
            activeTasks.map((task) => {
              const expanded = inSplitPane && expandedId === task.id;
              return (
                <article
                  key={task.id}
                  className={`task-card${expanded ? " task-card--expanded" : ""}`}
                >
                  <div className="task-card-body">
                    <div className="task-card-title">
                      <span
                        className={`task-priority-badge priority-${task.priority}`}
                        title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                      >
                        P{task.priority}
                      </span>
                      <h3>
                        <button
                          type="button"
                          className="task-card-title-link"
                          onClick={() =>
                            inSplitPane
                              ? setExpandedId((id) =>
                                  id === task.id ? null : task.id
                                )
                              : openEdit(task)
                          }
                          aria-expanded={inSplitPane ? expanded : undefined}
                          title="Open task details"
                        >
                          {task.name}
                        </button>
                      </h3>
                    </div>
                  </div>
                  {expanded && (
                    <div className="task-card-detail">
                      <p className="task-card-detail-desc">
                        {task.description?.trim()
                          ? task.description
                          : "No description."}
                      </p>
                    </div>
                  )}
                  {(!inSplitPane || expanded) && (
                    <div className="task-card-actions">
                      <button
                        type="button"
                        className="task-edit-btn"
                        onClick={() => openEdit(task)}
                        aria-label={`Edit ${task.name}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="task-delete-btn"
                        onClick={() => deleteTask(task)}
                        aria-label={`Delete ${task.name}`}
                      >
                        Delete
                      </button>
                      <select
                        className={`task-status-select task-status-select--${task.status}`}
                        value={task.status}
                        onChange={(event) =>
                          void changeStatus(
                            task,
                            event.target.value as TaskStatus
                          )
                        }
                        aria-label={`Status of ${task.name}`}
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        {!loading && !loadError && completedTasks.length > 0 && (
          <section className="task-completed-section">
            <h3 className="task-completed-title">
              Completed tasks
              <span className="task-completed-count">
                {completedTasks.length}
              </span>
            </h3>
            <div className={`task-list task-list--${view}`}>
              {completedTasks.map((task) => (
                <article
                  key={task.id}
                  className="task-card task-card--completed"
                >
                  <div className="task-card-body">
                    <div className="task-card-title">
                      <span
                        className={`task-priority-badge priority-${task.priority}`}
                        title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                      >
                        P{task.priority}
                      </span>
                      <h3>
                        <button
                          type="button"
                          className="task-card-title-link"
                          onClick={() => openEdit(task)}
                          title="Open task details"
                        >
                          {task.name}
                        </button>
                      </h3>
                    </div>
                  </div>
                  <div className="task-card-actions">
                    <button
                      type="button"
                      className="task-edit-btn"
                      onClick={() => openEdit(task)}
                      aria-label={`Edit ${task.name}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="task-delete-btn"
                      onClick={() => deleteTask(task)}
                      aria-label={`Delete ${task.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
