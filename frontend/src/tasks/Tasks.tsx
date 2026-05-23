import { FormEvent, useMemo, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import "./tasks.css";

type Priority = 1 | 2 | 3 | 4 | 5;

type Task = {
  id: number;
  name: string;
  description: string;
  priority: Priority;
  createdAt: string;
};

const PRIORITY_OPTIONS: Priority[] = [5, 4, 3, 2, 1];

const priorityLabel = (priority: Priority) => {
  if (priority === 5) return "Highest";
  if (priority === 4) return "High";
  if (priority === 3) return "Medium";
  if (priority === 2) return "Low";
  return "Lowest";
};

export default function Tasks() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const isPersonal = user?.scope === "personal";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [creating, setCreating] = useState(false);
  const [taskName, setTaskName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(3);
  const [error, setError] = useState("");

  const visibleTasks = useMemo(() => {
    const filtered = !normalizedSearchQuery
      ? tasks
      : tasks.filter((task) =>
          [task.name, task.description]
            .join(" ")
            .toLowerCase()
            .includes(normalizedSearchQuery),
        );

    // Sort priority desc (5 = Highest at top); tie-break by newest first.
    return [...filtered].sort(
      (a, b) =>
        b.priority - a.priority ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [normalizedSearchQuery, tasks]);

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = taskName.trim();
    const details = description.trim();

    if (!name) {
      setError("Task name is required");
      return;
    }

    setTasks((prev) => [
      {
        id: Date.now(),
        name,
        description: details,
        priority,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setTaskName("");
    setDescription("");
    setPriority(3);
    setError("");
    setCreating(false);
  };

  return (
    <div className={`tasks-app${isPersonal ? " tasks-app--personal" : ""}`}>
      {!isPersonal && (
        <aside className="tasks-sidebar">
          <button
            className="create-task-btn"
            onClick={() => {
              setCreating(true);
              setError("");
            }}
          >
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
            {isPersonal && (
              <button
                className="create-task-btn create-task-btn--inline"
                onClick={() => {
                  setCreating(true);
                  setError("");
                }}
              >
                + Create task
              </button>
            )}
          </div>
        </div>

        {creating && (
          <form className="task-create-form" onSubmit={createTask}>
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
                onClick={() => {
                  setCreating(false);
                  setTaskName("");
                  setDescription("");
                  setPriority(3);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                Create task
              </button>
            </div>
          </form>
        )}

        <div className="task-list">
          {visibleTasks.length === 0 ? (
            <div className="tasks-empty">
              <strong>{tasks.length === 0 ? "No tasks yet" : "No matching tasks"}</strong>
              <span>
                {tasks.length === 0
                  ? "Use + Create task to add your first task."
                  : "Try a different search term."}
              </span>
            </div>
          ) : (
            visibleTasks.map((task) => (
              <article key={task.id} className="task-card">
                <div>
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
                <time dateTime={task.createdAt}>
                  {new Date(task.createdAt).toLocaleDateString()}
                </time>
              </article>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
