import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  createTaskApi,
  deleteTaskApi,
  getTasks,
  updateTaskApi,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../api/tasks";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
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

const normalizeStatus = (value: unknown): TaskStatus =>
  value === "done" ? "done" : "in_progress";

const sortTasks = (list: Task[]) =>
  [...list].sort(
    (a, b) =>
      b.priority - a.priority ||
      new Date(b.created_at ?? 0).getTime() -
        new Date(a.created_at ?? 0).getTime(),
  );

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
];

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

export default function Tasks() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const isPersonal = user?.scope === "personal";
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
          })),
        ),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const resetForm = () => {
    setTaskName("");
    setDescription("");
    setPriority(3);
    setEditingId(null);
    setError("");
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
    setError("");
    setCreating(true);
  };

  const changeStatus = async (task: Task, nextStatus: TaskStatus) => {
    if (task.status === nextStatus) return;
    // Optimistic flip — visual cost of a request-then-update lag is jarring
    // when the user toggles status repeatedly. We roll back on failure.
    const prev = tasks;
    setTasks((current) =>
      sortTasks(
        current.map((t) =>
          t.id === task.id ? { ...t, status: nextStatus } : t,
        ),
      ),
    );
    try {
      const updated = await updateTaskApi(task.id, {
        name: task.name,
        description: task.description,
        priority: task.priority,
        status: nextStatus,
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
              : t,
          ),
        ),
      );
    } catch (err) {
      setTasks(prev);
      window.alert(
        err instanceof Error ? err.message : "Failed to update status",
      );
    }
  };

  const deleteTask = async (task: Task) => {
    const ok = window.confirm(
      `Delete task "${task.name}"? This cannot be undone.`,
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
      window.alert(err instanceof Error ? err.message : "Failed to delete task");
    }
  };

  const visibleTasks = useMemo(() => {
    if (!normalizedSearchQuery) return tasks;
    return tasks.filter((task) =>
      [task.name, task.description]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery),
    );
  }, [normalizedSearchQuery, tasks]);

  const activeTasks = useMemo(
    () => visibleTasks.filter((t) => t.status !== "done"),
    [visibleTasks],
  );

  const completedTasks = useMemo(
    () => visibleTasks.filter((t) => t.status === "done"),
    [visibleTasks],
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
      if (editingId !== null) {
        const existing = tasks.find((t) => t.id === editingId);
        const updated = await updateTaskApi(editingId, {
          name,
          description: details,
          priority,
          status: existing?.status ?? "in_progress",
        });
        setTasks((prev) =>
          sortTasks(
            prev.map((t) =>
              t.id === updated.id
                ? {
                    ...updated,
                    priority: normalizePriority(updated.priority),
                    status: normalizeStatus(updated.status),
                  }
                : t,
            ),
          ),
        );
      } else {
        const created = await createTaskApi({
          name,
          description: details,
          priority,
          status: "in_progress",
        });
        setTasks((prev) =>
          sortTasks([
            ...prev,
            {
              ...created,
              priority: normalizePriority(created.priority),
              status: normalizeStatus(created.status),
            },
          ]),
        );
      }
      resetForm();
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`tasks-app${isPersonal ? " tasks-app--personal" : ""}`}>
      {!isPersonal && (
        <aside className="tasks-sidebar">
          <button className="create-task-btn" onClick={openCreate}>
            + Create task
          </button>

          <div className="task-filter-title">Tasks</div>
          <button className="task-filter active">All tasks</button>
          <button className="task-filter">Created by me</button>
          <button className="task-filter">Recently added</button>
        </aside>
      )}

      <main className="tasks-main">
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
            {isPersonal && (
              <button
                className="create-task-btn create-task-btn--inline"
                onClick={openCreate}
              >
                + Create task
              </button>
            )}
          </div>
        </div>

        {creating && (
          <form className="task-create-form" onSubmit={saveTask}>
            <div className="task-form-grid">
              <label>
                <span>Task name</span>
                <input
                  value={taskName}
                  onChange={(event) => setTaskName(event.target.value)}
                  placeholder="Enter task name"
                  autoFocus
                />
              </label>

              <label>
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Add task details"
                />
              </label>

              <fieldset className="task-priority">
                <legend>Priority</legend>
                <div className="task-priority-options">
                  {PRIORITY_OPTIONS.map((value) => (
                    <label key={value} className="task-priority-option">
                      <input
                        type="radio"
                        name="task-priority"
                        value={value}
                        checked={priority === value}
                        onChange={() => setPriority(value)}
                      />
                      <span className="task-priority-num">{value}</span>
                      <span className="task-priority-text">
                        {priorityLabel(value)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

            </div>

            {error && <div className="task-error">{error}</div>}

            <div className="task-form-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  resetForm();
                  setCreating(false);
                }}
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
                    : "Create task"}
              </button>
            </div>
          </form>
        )}

        {!creating && (
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
            activeTasks.map((task) => (
              <article key={task.id} className="task-card">
                <div className="task-card-body">
                  <div className="task-card-title">
                    <span
                      className={`task-priority-badge priority-${task.priority}`}
                      title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                    >
                      P{task.priority}
                    </span>
                    <h3>{task.name}</h3>
                  </div>
                  <p>{task.description || "No description added."}</p>
                </div>
                <div className="task-card-meta">
                  {task.created_at && (
                    <time dateTime={task.created_at}>
                      {formatDate(task.created_at)}
                    </time>
                  )}
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
                          event.target.value as TaskStatus,
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
                </div>
              </article>
            ))
          )}
        </div>
        )}

        {!creating && !loading && !loadError && completedTasks.length > 0 && (
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
                      <h3>{task.name}</h3>
                    </div>
                    <p>{task.description || "No description added."}</p>
                  </div>
                  <div className="task-card-meta">
                    {task.created_at && (
                      <time dateTime={task.created_at}>
                        {formatDate(task.created_at)}
                      </time>
                    )}
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
