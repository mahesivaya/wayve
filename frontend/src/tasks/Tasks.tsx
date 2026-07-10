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
  getAssignableUsers,
  getProjects,
  getTasks,
  listTaskAttachments,
  suggestAssignee,
  updateTaskApi,
  uploadTaskAttachments,
  type AssigneeSuggestion,
  type AssignableUser,
  type Project,
  type Task,
  type TaskAttachment,
  type TaskPriority,
  type TaskStatus,
} from "../api/tasks";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import Modal from "../components/Modal";
import Avatar from "../components/Avatar";
import { useInSplitPane } from "../components/SplitPaneContext";
import { getApiBase } from "../config/env";
import { JiraBadge } from "./JiraPanel";
import { GitlabBadge } from "./GitlabBadge";
import "./tasks.css";

const PRIORITY_OPTIONS: TaskPriority[] = [5, 4, 3, 2, 1];

const priorityLabel = (priority: TaskPriority) => {
  if (priority === 5) return "Highest";
  if (priority === 4) return "High";
  if (priority === 3) return "Medium";
  if (priority === 2) return "Low";
  return "Lowest";
};

// Render a task's creation timestamp as a localized date + time, e.g.
// "Jun 17, 2026, 3:42 PM". Returns "" when the field is missing or unparseable
// so the UI simply omits the line.
const formatCreatedAt = (value: string | null | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

// A free-text input backed by a live-filtered dropdown of organization /
// platform users. Typing narrows the list by email OR username; picking a row
// fills the email. Still accepts a hand-typed value (e.g. an external email or
// a member the list hasn't loaded), so it degrades to a plain input when the
// user list is empty or failed to load.
function UserAutocomplete({
  id,
  value,
  onChange,
  users,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  users: AssignableUser[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const query = value.trim().toLowerCase();
  const matches = useMemo(() => {
    const list = query
      ? users.filter(
          (u) =>
            u.email.toLowerCase().includes(query) ||
            (u.username ?? "").toLowerCase().includes(query)
        )
      : users;
    return list.slice(0, 8);
  }, [users, query]);

  useEffect(() => {
    const onDocPointer = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    return () => document.removeEventListener("mousedown", onDocPointer);
  }, []);

  const select = (u: AssignableUser) => {
    onChange(u.email);
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIdx((i) => (i + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIdx((i) => (i <= 0 ? matches.length - 1 : i - 1));
    } else if (event.key === "Enter" && activeIdx >= 0) {
      event.preventDefault();
      select(matches[activeIdx]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="task-assignee" ref={wrapRef}>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIdx(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && matches.length > 0 && (
        <ul className="task-assignee-menu" role="listbox">
          {matches.map((u, i) => (
            <li
              key={u.user_id}
              role="option"
              aria-selected={i === activeIdx}
              className={`task-assignee-option${i === activeIdx ? " active" : ""}`}
              onMouseDown={(event) => {
                // mousedown (not click) so we beat the input's blur/outside
                // handler and the selection still registers.
                event.preventDefault();
                select(u);
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <Avatar
                name={u.username || u.email}
                src={`${getApiBase()}/api/users/${u.user_id}/avatar`}
                size={28}
              />
              <span className="task-assignee-text">
                <span className="task-assignee-email">{u.email}</span>
                {u.username && (
                  <span className="task-assignee-username">{u.username}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A small "copy task link" control shown on every task card. Copies a shareable
// deep link (…/tasks?task=<id>) to the clipboard so the task can be pasted into
// chat/email and reopened straight to its details. Stays a compact icon — the
// "Copy link" hint rides the native cursor tooltip (title) — and on a successful
// copy swaps to a green check and pops a small "Copied!" text confirmation
// above the button. `stopPropagation` keeps a click from also toggling the
// card's expand/edit handler.
function CopyLinkButton({
  copied,
  onCopy,
  label,
}: {
  copied: boolean;
  onCopy: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`task-copy-link${copied ? " task-copy-link--copied" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onCopy();
      }}
      title={copied ? "Link copied" : "Copy link"}
      aria-label={copied ? `Link to ${label} copied` : `Copy link to ${label}`}
    >
      {copied ? (
        <svg
          className="task-copy-link-icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      ) : (
        <svg
          className="task-copy-link-icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Classic "copy" glyph — two overlapping dog-eared pages. */}
          <path d="M2.5 6.5V13.5H9.5V8.5L7.5 6.5Z" />
          <path d="M7.5 6.5V8.5H9.5" />
          <path d="M5.5 6.5V3.5H10.5L12.5 5.5V10.5H9.5" />
          <path d="M10.5 3.5V5.5H12.5" />
        </svg>
      )}
      {copied && (
        <span className="task-copy-link-toast" role="status">
          Copied!
        </span>
      )}
    </button>
  );
}

// The friendly task-key pill (e.g. "way12" — project prefix + task number, or
// "#12" when project-less). Renders nothing when there's no key.
function TaskKeyBadge({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <span className="task-number-badge" title="Task key">
      {value}
    </span>
  );
}


export default function Tasks() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const isPersonal = user?.scope === "personal";
  // In a split pane the Tasks page collapses to a single column (Create button
  // → list) and clicking a task expands it inline (accordion) instead of
  // opening the edit modal.
  const inSplitPane = useInSplitPane();
  const [searchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Id of the task whose share-link was just copied, so its copy button can
  // briefly show a ✓. Cleared after a short delay.
  const [copiedTaskId, setCopiedTaskId] = useState<number | null>(null);
  // Guards the one-shot deep-link open (?task=<id>) so closing the opened task
  // doesn't immediately reopen it on the next render.
  const deepLinkApplied = useRef(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Org/platform users available for the Assigned by / Assignee pickers.
  // Personal accounts have no team, so we skip the fetch for them.
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<"list" | "grid">(() => {
    const saved = window.localStorage.getItem("wayve.tasks.view");
    return saved === "grid" ? "grid" : "list";
  });
  // "tasks" = the default list/grid layout; "jira" = a kanban board with one
  // column per status (To Do / In Progress / In Review / Done), cards dragged
  // between columns to change status.
  const [mode, setMode] = useState<"tasks" | "jira">(() => {
    const saved = window.localStorage.getItem("wayve.tasks.mode");
    return saved === "jira" ? "jira" : "tasks";
  });
  // Quick status filter (All / To Do / In Progress / In Review / Done). Applies
  // to the list and board so you can focus on one status at a time.
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  // Quick priority filter (All / P5…P1). Combined with the status filter.
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all"
  );
  // Status column currently being hovered during a drag, for the drop-target
  // highlight.
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);

  useEffect(() => {
    window.localStorage.setItem("wayve.tasks.view", view);
  }, [view]);

  useEffect(() => {
    window.localStorage.setItem("wayve.tasks.mode", mode);
  }, [mode]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [taskName, setTaskName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);
  const [status, setStatus] = useState<TaskStatus>("to_do");
  const [assignedBy, setAssignedBy] = useState("");
  const [assignee, setAssignee] = useState("");
  // Chosen assignee's user id (kept in sync when a real member is picked); the
  // project the task is created on, and the loaded project list for the dropdown.
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  // Assignee suggestions from the project's code history.
  const [suggestions, setSuggestions] = useState<AssigneeSuggestion[] | null>(
    null
  );
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [suggestUsedAi, setSuggestUsedAi] = useState(true);
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

  // Load the assignable-users list once for non-personal accounts. Failure is
  // non-fatal — the assignee fields simply behave as plain text inputs.
  useEffect(() => {
    if (isPersonal) return;
    let alive = true;
    getAssignableUsers()
      .then((list) => {
        if (alive) setAssignableUsers(list);
      })
      .catch(() => {
        // Non-fatal: leave the list empty so the pickers fall back to text.
      });
    return () => {
      alive = false;
    };
  }, [isPersonal]);

  // Load the caller's projects for the create-task dropdown. The selected
  // project links the task to a repo, which drives assignee suggestions.
  // Failure is non-fatal — the dropdown simply shows no options.
  useEffect(() => {
    let alive = true;
    getProjects()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch(() => {
        // Non-fatal: no projects to choose from.
      });
    return () => {
      alive = false;
    };
  }, []);

  const clearSuggestions = () => {
    setSuggestions(null);
    setSuggestNote(null);
    setSuggestLoading(false);
  };

  // Ask the backend to rank assignees from the selected project's code history.
  const loadSuggestions = async () => {
    if (projectId === null) return;
    setSuggestLoading(true);
    setSuggestNote(null);
    try {
      const res = await suggestAssignee({
        project_id: projectId,
        summary: taskName.trim(),
        description: description.trim(),
      });
      setSuggestions(res.candidates);
      setSuggestUsedAi(res.used_ai);
      setSuggestNote(
        res.note ?? (res.candidates.length === 0 ? "No suggestions found." : null)
      );
    } catch (err) {
      setSuggestions([]);
      setSuggestNote(
        err instanceof Error ? err.message : "Couldn't load suggestions."
      );
    } finally {
      setSuggestLoading(false);
    }
  };

  // Choose a suggested person. Connected members become the real assignee (with
  // an id); reference-only contributors fill the free-text field with no id.
  const pickSuggestion = (s: AssigneeSuggestion) => {
    if (s.user_id !== null) {
      setAssignee(s.email ?? s.display);
      setAssigneeId(s.user_id);
    } else {
      setAssignee(s.display);
      setAssigneeId(null);
    }
  };

  const resetForm = () => {
    setTaskName("");
    setDescription("");
    setPriority(3);
    setStatus("to_do");
    // New tasks are attributed to their creator: default "assigned by" to the
    // current user (personal accounts leave it unset — implicitly self-owned).
    setAssignedBy(isPersonal ? "" : (user?.email ?? ""));
    setAssignee("");
    setAssigneeId(null);
    setProjectId(null);
    clearSuggestions();
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
    setAssigneeId(task.assignee_id ?? null);
    setProjectId(task.project_id ?? null);
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

  // Shareable deep link for a task — pasteable into chat/email; opening it
  // navigates to the Tasks page and auto-opens the task's details.
  const taskLink = (task: Task) =>
    `${window.location.origin}/tasks?task=${task.id}`;

  const copyTaskLink = (task: Task) => {
    void navigator.clipboard?.writeText(taskLink(task)).then(() => {
      setCopiedTaskId(task.id);
      window.setTimeout(
        () => setCopiedTaskId((id) => (id === task.id ? null : id)),
        1500
      );
    });
  };

  // Honor a ?task=<id> deep link once the tasks have loaded: open the target
  // task's details (edit modal in full width, inline accordion in a split
  // pane). Runs once — guarded so closing the task doesn't reopen it.
  useEffect(() => {
    if (deepLinkApplied.current || loading) return;
    const raw = searchParams.get("task");
    if (!raw) return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const target = tasks.find((t) => t.id === id);
    if (!target) return;
    deepLinkApplied.current = true;
    // Deferred to a microtask so the effect body doesn't synchronously call
    // setState (same React 19 cascading-render guard as loadTasks above).
    const timer = window.setTimeout(() => {
      if (inSplitPane) {
        setExpandedId(id);
      } else {
        openEdit(target);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, tasks, searchParams, inSplitPane]);

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

  // Inline priority change from a card's top-right selector. Optimistic like
  // changeStatus (and re-sorts, since the list is priority-ordered), rolling
  // back on failure.
  // Human-friendly task key for the card badge: the task's project name, first
  // three letters, followed by the per-user task number (e.g. project "wayve"
  // → "way12"). Falls back to a plain "#12" when the task has no resolvable
  // project so imported/project-less tasks still show an identifier.
  const taskKey = (task: Task): string | null => {
    if (task.task_number == null) return null;
    const name = projects.find((p) => p.id === task.project_id)?.name ?? "";
    const prefix = name
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 3)
      .toLowerCase();
    return prefix ? `${prefix}${task.task_number}` : `#${task.task_number}`;
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

  // Search-filtered tasks, further narrowed to the selected status and priority.
  const filteredTasks = useMemo(
    () =>
      visibleTasks.filter(
        (t) =>
          (statusFilter === "all" || t.status === statusFilter) &&
          (priorityFilter === "all" || t.priority === priorityFilter)
      ),
    [visibleTasks, statusFilter, priorityFilter]
  );

  const activeTasks = useMemo(
    () => filteredTasks.filter((t) => t.status !== "done"),
    [filteredTasks]
  );

  const completedTasks = useMemo(
    () => filteredTasks.filter((t) => t.status === "done"),
    [filteredTasks]
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
          assignee_id: assigneeId,
          project_id: projectId,
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
          assignee_id: assigneeId,
          project_id: projectId,
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
              <select
                className="tasks-status-filter"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as TaskStatus | "all")
                }
                aria-label="Filter by status"
                title="Filter by status"
              >
                <option value="all">All statuses</option>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <select
                className="tasks-status-filter"
                value={priorityFilter}
                onChange={(e) =>
                  setPriorityFilter(
                    e.target.value === "all"
                      ? "all"
                      : (Number(e.target.value) as TaskPriority)
                  )
                }
                aria-label="Filter by priority"
                title="Filter by priority"
              >
                <option value="all">All priorities</option>
                {PRIORITY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {`P${value} — ${priorityLabel(value)}`}
                  </option>
                ))}
              </select>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`view-toggle-btn${mode === "tasks" && view === "list" ? " active" : ""}`}
                  onClick={() => {
                    setMode("tasks");
                    setView("list");
                  }}
                  aria-pressed={mode === "tasks" && view === "list"}
                  aria-label="List view"
                  title="List view"
                >
                  ☰
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn${mode === "tasks" && view === "grid" ? " active" : ""}`}
                  onClick={() => {
                    setMode("tasks");
                    setView("grid");
                  }}
                  aria-pressed={mode === "tasks" && view === "grid"}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  ⊞
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn${mode === "jira" ? " active" : ""}`}
                  onClick={() => setMode("jira")}
                  aria-pressed={mode === "jira"}
                  aria-label="Columns (Jira board) view"
                  title="Columns (Jira board) view"
                >
                  ◫
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
                <span className="task-form-label">Project</span>
                <select
                  className="task-form-select"
                  value={projectId ?? ""}
                  onChange={(event) => {
                    setProjectId(
                      event.target.value ? Number(event.target.value) : null
                    );
                    clearSuggestions();
                  }}
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.github_owner && p.github_repo
                        ? ` (${p.github_owner}/${p.github_repo})`
                        : ""}
                    </option>
                  ))}
                </select>
                <span className="task-form-hint">
                  Pick the project so we can suggest assignees from its code
                  history
                </span>
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

              {/* Task assignment (Assignee / Assign to me) is a team feature —
                  only business (organization) accounts see it. Personal accounts
                  are single-user, so it's hidden for them. "Assigned by" is not
                  shown: a task is always attributed to its creator. */}
              {!isPersonal && (
                <>
                  <div className="task-form-field">
                    <label className="task-form-label" htmlFor="task-assignee">
                      Assignee
                    </label>
                    <UserAutocomplete
                      id="task-assignee"
                      value={assignee}
                      onChange={(value) => {
                        setAssignee(value);
                        const match = assignableUsers.find(
                          (u) =>
                            u.email.toLowerCase() === value.trim().toLowerCase()
                        );
                        setAssigneeId(match ? match.user_id : null);
                      }}
                      users={assignableUsers}
                      placeholder="Search team by name or email"
                    />
                    {user?.email && (
                      <span className="task-form-assign-me">
                        <input
                          type="checkbox"
                          checked={
                            assignee.trim().toLowerCase() ===
                            user.email.toLowerCase()
                          }
                          onChange={(event) => {
                            if (event.target.checked && user.email) {
                              setAssignee(user.email);
                              const match = assignableUsers.find(
                                (u) =>
                                  u.email.toLowerCase() ===
                                  user.email.toLowerCase()
                              );
                              setAssigneeId(match ? match.user_id : null);
                            } else {
                              setAssignee("");
                              setAssigneeId(null);
                            }
                          }}
                        />
                        Assign to me
                      </span>
                    )}
                  </div>

                  {/* Assignee suggestions from the project's code history —
                      available once a project is selected. */}
                  {projectId !== null && (
                    <div className="task-suggest">
                      <button
                        type="button"
                        className="task-suggest-btn"
                        onClick={() => void loadSuggestions()}
                        disabled={suggestLoading}
                      >
                        {suggestLoading
                          ? "Finding people who worked here…"
                          : "Suggest assignees from code history"}
                      </button>
                      {suggestions &&
                        suggestions.length > 0 &&
                        !suggestUsedAi && (
                          <span className="task-suggest-hint">
                            Matched by keyword (AI unavailable)
                          </span>
                        )}
                      {suggestNote && (
                        <p className="task-suggest-note">{suggestNote}</p>
                      )}
                      {suggestions && suggestions.length > 0 && (
                        <ul className="task-suggest-list">
                          {suggestions.map((s, i) => (
                            <li
                              key={`${s.github_login ?? s.display}-${i}`}
                              className="task-suggest-item"
                            >
                              <button
                                type="button"
                                className="task-suggest-pick"
                                onClick={() => pickSuggestion(s)}
                              >
                                <span className="task-suggest-name">
                                  {s.display}
                                  {s.is_reference_only && (
                                    <span className="task-suggest-ref">
                                      {" "}
                                      · reference
                                    </span>
                                  )}
                                </span>
                                <span className="task-suggest-reason">
                                  {s.reason}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
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

        {mode === "jira" ? (
          loading ? (
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
          ) : (
            <div className="task-board">
              {STATUS_OPTIONS.map((col) => {
                const colTasks = filteredTasks.filter(
                  (t) => t.status === col.value
                );
                return (
                  <section
                    key={col.value}
                    className={`task-board-col task-board-col--${col.value}${
                      dragOverStatus === col.value
                        ? " task-board-col--dragover"
                        : ""
                    }`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (dragOverStatus !== col.value)
                        setDragOverStatus(col.value);
                    }}
                    onDragLeave={(event) => {
                      // Only clear when the pointer actually leaves the column,
                      // not when it crosses onto a child card.
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        setDragOverStatus((s) => (s === col.value ? null : s));
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOverStatus(null);
                      const id = Number(
                        event.dataTransfer.getData("text/plain")
                      );
                      const dropped = tasks.find((t) => t.id === id);
                      if (dropped) void changeStatus(dropped, col.value);
                    }}
                  >
                    <header className="task-board-col-header">
                      <span className="task-board-col-title">{col.label}</span>
                      <span className="task-board-col-count">
                        {colTasks.length}
                      </span>
                    </header>
                    <div className="task-board-col-body">
                      {colTasks.length === 0 ? (
                        <div className="task-board-empty">No tasks</div>
                      ) : (
                        colTasks.map((task) => (
                          <article
                            key={task.id}
                            className="task-board-card"
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(
                                "text/plain",
                                String(task.id)
                              );
                            }}
                          >
                            <div className="task-board-card-top">
                              <span
                                className={`task-priority-badge priority-${task.priority}`}
                                title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                              >
                                P{task.priority}
                              </span>
                              <TaskKeyBadge value={taskKey(task)} />
                              <CopyLinkButton
                                copied={copiedTaskId === task.id}
                                onCopy={() => copyTaskLink(task)}
                                label={task.name}
                              />
                            </div>
                            <button
                              type="button"
                              className="task-card-title-link task-board-card-title"
                              onClick={() => openEdit(task)}
                              title="Open task details"
                            >
                              {task.name}
                            </button>
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                            {formatCreatedAt(task.created_at) && (
                              <span className="task-card-created task-board-card-created">
                                Created {formatCreatedAt(task.created_at)}
                              </span>
                            )}
                            <div className="task-board-card-actions">
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
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )
        ) : (
          <>
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
              ) : filteredTasks.length === 0 ? (
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
                          <TaskKeyBadge value={taskKey(task)} />
                          <CopyLinkButton
                            copied={copiedTaskId === task.id}
                            onCopy={() => copyTaskLink(task)}
                            label={task.name}
                          />
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
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                          </h3>
                          <span
                            className={`task-priority-badge priority-${task.priority}`}
                            title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                          >
                            P{task.priority}
                          </span>
                        </div>
                        {formatCreatedAt(task.created_at) && (
                          <span className="task-card-created">
                            Created {formatCreatedAt(task.created_at)}
                          </span>
                        )}
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
                          <TaskKeyBadge value={taskKey(task)} />
                          <CopyLinkButton
                            copied={copiedTaskId === task.id}
                            onCopy={() => copyTaskLink(task)}
                            label={task.name}
                          />
                          <h3>
                            <button
                              type="button"
                              className="task-card-title-link"
                              onClick={() => openEdit(task)}
                              title="Open task details"
                            >
                              {task.name}
                            </button>
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                          </h3>
                          <span
                            className={`task-priority-badge priority-${task.priority}`}
                            title={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                          >
                            P{task.priority}
                          </span>
                        </div>
                        {formatCreatedAt(task.created_at) && (
                          <span className="task-card-created">
                            Created {formatCreatedAt(task.created_at)}
                          </span>
                        )}
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
          </>
        )}
      </main>
    </div>
  );
}
