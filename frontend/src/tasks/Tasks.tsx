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
  type SaveTaskPayload,
  type Task,
  type TaskAttachment,
  type TaskPriority,
  type TaskStatus,
} from "../api/tasks";
import {
  getTaskStatuses,
  isTerminalCategory,
  type TaskStatusRow,
} from "../api/taskStatuses";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { taskShareText } from "./taskShareLink";
import { useGlobalSearch } from "../search/SearchContext";
import Modal from "../components/Modal";
import Avatar from "../components/Avatar";
import { useInSplitPane } from "../components/SplitPaneContext";
import { getApiBase } from "../config/env";
import { JiraBadge } from "./JiraPanel";
import { GitlabBadge } from "./GitlabBadge";
import TaskStatusIcon from "./TaskStatusIcon";
import "./tasks.css";

const PRIORITY_OPTIONS: TaskPriority[] = [5, 4, 3, 2, 1];

const priorityLabel = (priority: TaskPriority) => {
  if (priority === 5) return "Highest";
  if (priority === 4) return "High";
  if (priority === 3) return "Medium";
  if (priority === 2) return "Low";
  return "Lowest";
};

// Returns "" for a missing or unparseable timestamp so the UI omits the line.
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

// Date only (no time), for the table's Created column. "" when unparseable so
// the cell shows a dash.
const formatCreatedDate = (value: string | null | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const normalizePriority = (value: unknown): TaskPriority => {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3 || n === 4 || n === 5) return n;
  return 3;
};

/**
 * Coerce a server value to a status slug the loaded set actually contains.
 *
 * The old version hardcoded the four legal slugs and fell back to `to_do`. With
 * user-defined statuses there is no fixed list to check against, so the loaded
 * rows are the authority and the first status (board order) is the fallback.
 * Returning the raw value when the set hasn't loaded yet matters: coercing
 * during the initial render would flash every task onto the wrong status.
 */
const normalizeStatus = (
  value: unknown,
  known: TaskStatusRow[]
): TaskStatus => {
  const slug = typeof value === "string" ? value : "";
  if (known.length === 0) return slug;
  if (known.some((s) => s.slug === slug)) return slug;
  return known[0].slug;
};

const sortTasks = (list: Task[]) =>
  [...list].sort(
    (a, b) =>
      b.priority - a.priority ||
      // Oldest first within a priority group, so a new task lands at the bottom.
      new Date(a.created_at ?? 0).getTime() -
        new Date(b.created_at ?? 0).getTime()
  );

/**
 * Statuses are loaded per org, so a task's slug may not resolve while the list
 * is still in flight (or if a status was deleted out from under a stale tab).
 * This keeps such a task visible with a readable label instead of rendering a
 * blank chip.
 */
const UNKNOWN_STATUS = (slug: string): TaskStatusRow => ({
  id: -1,
  slug,
  name: slug || "Unknown",
  description: "",
  color: "#6b7280",
  category: "backlog",
  position: 0,
  task_count: 0,
});

// Linear-style assignee dropdown: the list of assignable users shows
// immediately, with a "No assignee" row on top and a checkmark on the current
// selection. A slim filter input appears only for larger teams. Extra footer
// content (the code-history suggestions) renders below the list.
function AssigneeMenu({
  users,
  selectedEmail,
  onSelect,
  onClose,
  children,
}: {
  users: AssignableUser[];
  selectedEmail: string;
  /** `null` selects "No assignee". */
  onSelect: (user: AssignableUser | null) => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          (u.username ?? "").toLowerCase().includes(q)
      )
    : users;
  const selected = selectedEmail.trim().toLowerCase();

  return (
    <div
      className="task-assignee-pop"
      role="dialog"
      aria-label="Choose assignee"
    >
      {users.length > 6 && (
        <input
          className="task-assignee-filter"
          value={query}
          placeholder="Search team…"
          autoComplete="off"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Close only the menu — the modal's own ESC handler listens on
              // window, so stop the event from reaching it.
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (matches.length > 0) onSelect(matches[0]);
            }
          }}
        />
      )}
      <ul className="task-assignee-options" role="listbox">
        <li>
          <button
            type="button"
            role="option"
            aria-selected={selected === ""}
            className="task-assignee-row"
            onClick={() => onSelect(null)}
          >
            <svg
              className="task-assignee-row-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <circle cx="8" cy="5.5" r="2.8" />
              <path d="M2.5 14c.8-2.8 3-4.2 5.5-4.2s4.7 1.4 5.5 4.2" />
            </svg>
            <span className="task-assignee-row-name">No assignee</span>
            {selected === "" && (
              <span className="task-assignee-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        </li>
        {matches.map((u) => {
          const isSelected = u.email.toLowerCase() === selected;
          return (
            <li key={u.user_id}>
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className="task-assignee-row"
                onClick={() => onSelect(u)}
              >
                <Avatar
                  name={u.username || u.email}
                  src={`${getApiBase()}/api/users/${u.user_id}/avatar`}
                  size={22}
                />
                <span className="task-assignee-row-name">
                  {u.username || u.email}
                </span>
                {isSelected && (
                  <span className="task-assignee-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {matches.length === 0 && (
          <li className="task-assignee-empty">No matching teammates</li>
        )}
      </ul>
      {children}
    </div>
  );
}

// Copies a share snippet (`#42 Task name`) so the task can be pasted into chat
// and reopened from the linked reference. `stopPropagation` keeps the click
// from also toggling the card's expand/edit handler.
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
      data-tooltip={copied ? "Link copied" : "Copy link"}
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

// The task-key pill ("way12", or "#12" when project-less). Renders nothing when
// there's no key.
function TaskKeyBadge({
  value,
  tooltip,
}: {
  value: string | null;
  tooltip: string;
}) {
  if (!value) return null;
  return (
    <span className="task-number-badge" data-tooltip={tooltip}>
      {value}
    </span>
  );
}

// Emoji + label per support-ticket category, driving the coloured card pill for
// tickets materialised from a reported bug (Task.badge_kind). Unknown/absent
// kinds render nothing, so tasks and user stories are unaffected.
const BADGE_KINDS: Record<string, { icon: string; label: string }> = {
  bug: { icon: "", label: "Bug" },
  feature: { icon: "✨", label: "Feature" },
  billing: { icon: "💳", label: "Billing" },
  account: { icon: "👤", label: "Account" },
  other: { icon: "📌", label: "Report" },
};

function TaskBadge({ kind }: { kind?: string | null }) {
  if (!kind) return null;
  const meta = BADGE_KINDS[kind] ?? { icon: "📌", label: kind };
  return (
    <span
      className={`ticket-kind-badge ticket-kind-${kind}`}
      data-tooltip="Reported by a user"
    >
      {meta.icon ? `${meta.icon} ${meta.label}` : meta.label}
    </span>
  );
}

// Hosts the compose/edit form on one of two surfaces: the centered modal (used
// for Create, and Edit on boards without a drawer) or a right-side drawer (used
// when an item's name is clicked on a drawer-enabled board). The form is passed
// as `children`, so it is written once regardless of surface. `onExpand`, when
// given, renders a button that jumps to the full page.
function EditSurface({
  surface,
  isOpen,
  onClose,
  title,
  onExpand,
  children,
}: {
  surface: "modal" | "drawer";
  isOpen: boolean;
  onClose: () => void;
  title: string;
  onExpand?: () => void;
  children: React.ReactNode;
}) {
  // Modal has its own ESC handling; the drawer needs its own.
  useEffect(() => {
    if (surface !== "drawer" || !isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surface, isOpen, onClose]);

  if (surface === "modal") {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title}>
        {children}
      </Modal>
    );
  }
  if (!isOpen) return null;
  return (
    <>
      <div
        className="task-drawer-overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="task-drawer" role="dialog" aria-label={title}>
        <div className="task-drawer-head">
          <h2 className="task-drawer-title">{title}</h2>
          <div className="task-drawer-head-actions">
            {onExpand && (
              <button
                type="button"
                className="task-drawer-expand"
                onClick={onExpand}
                data-tooltip="Open full page"
                aria-label="Open full page"
              >
                ⤢
              </button>
            )}
            <button
              type="button"
              className="task-drawer-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
        <div className="task-drawer-body">{children}</div>
      </aside>
    </>
  );
}

// This component powers both the personal Tasks board (`/tasks`) and the
// org-shared Workspace "User Stories" board (`/user-stories`). Everything that
// differs between the two — the CRUD endpoints, the visible labels, the
// localStorage namespace, and whether attachments are available — is injected
// via `config`. The default is the Tasks configuration, so `<Tasks />` is
// unchanged; the stories wrapper passes its own config (see
// `frontend/src/userstories/UserStories.tsx`).
export type RelatedResult = {
  duplicates: number;
  similar: number;
};

export type TasksConfig = {
  api: {
    list: () => Promise<Task[]>;
    create: (payload: SaveTaskPayload) => Promise<Task>;
    update: (id: number, payload: SaveTaskPayload) => Promise<Task>;
    remove: (id: number) => Promise<void>;
    // Optional: on-demand AI pass that labels duplicate/similar tickets. Only
    // the Tickets board wires this (see api/tickets.ts).
    findRelated?: () => Promise<RelatedResult>;
    // Optional: dispatch the Claude Code CI fixer for one ticket. Tickets only.
    aiFix?: (id: number) => Promise<{ reused_fix_from: number | null }>;
    // Optional: attachment endpoints for this board's item type. Tasks hit
    // /api/tasks/…, Tickets hit /api/workspace-tickets/… — the board just calls
    // these. Only wired when `features.attachments` is on.
    listAttachments?: (id: number) => Promise<TaskAttachment[]>;
    uploadAttachments?: (id: number, files: File[]) => Promise<TaskAttachment[]>;
    deleteAttachment?: (id: number) => Promise<void>;
    downloadAttachment?: (attachment: TaskAttachment) => Promise<void>;
  };
  features: {
    // Attachments hit `/api/tasks/{id}/attachments`, which is task-only, so the
    // stories board disables them (there is no story-attachment endpoint).
    attachments: boolean;
    // Shows a per-status count strip above the board (total + each status). On
    // for the shared workspace boards (Tickets, User Stories).
    statusSummary?: boolean;
    // Shows the "Find related" (AI duplicate/similar) toolbar button. Tickets only.
    findRelated?: boolean;
    // Shows the "Fix with AI" button in the edit modal. Tickets only.
    aiFix?: boolean;
  };
  // localStorage prefix so the two boards keep independent view/mode state.
  storageKey: string;
  // When set, the Edit button (and deep links) routes to this path — a full
  // detail/edit page — instead of opening the edit modal. Tickets and User
  // Stories set it; personal Tasks leave it unset.
  detailPath?: (id: number) => string;
  // When true, clicking an item's *name* opens its editable form in a
  // right-side drawer (in-page) instead of navigating/opening the modal. The
  // Edit button still goes to `detailPath` (the full page). On for the shared
  // workspace boards (User Stories, Tickets).
  detailDrawer?: boolean;
  labels: {
    title: string;
    subtitle: string;
    singular: string;
    lowerSingular: string;
    lowerPlural: string;
    createButton: string;
    createTitle: string;
    editTitle: string;
    namePlaceholder: string;
    numberBadgeTooltip: string;
    filtersTooltip: string;
    filtersAria: string;
  };
};

const TASKS_CONFIG: TasksConfig = {
  api: {
    list: getTasks,
    create: createTaskApi,
    update: updateTaskApi,
    remove: deleteTaskApi,
    listAttachments: listTaskAttachments,
    uploadAttachments: uploadTaskAttachments,
    deleteAttachment: deleteTaskAttachment,
    downloadAttachment: downloadTaskAttachment,
  },
  features: { attachments: true },
  storageKey: "tasks",
  labels: {
    title: "Tasks",
    subtitle: "Create simple work items with a name and description.",
    singular: "Task",
    lowerSingular: "task",
    lowerPlural: "tasks",
    createButton: "+ Create task",
    createTitle: "Create Task",
    editTitle: "Edit Task",
    namePlaceholder: "Task title",
    numberBadgeTooltip: "Task key",
    filtersTooltip: "Filter tasks",
    filtersAria: "Task filters",
  },
};

export default function Tasks({
  config = TASKS_CONFIG,
}: {
  config?: TasksConfig;
} = {}) {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const isPersonal = user?.scope === "personal";
  // In a split pane the page collapses to one column and clicking a task
  // expands it inline instead of opening the edit modal.
  const inSplitPane = useInSplitPane();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Closing a task that was opened from a `?task=` chat link returns the user
  // to Messages rather than dropping them on the full task list.
  const openedFromDeepLink = useRef(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<number | null>(null);
  // Last deep-link value auto-opened. Guards against reopening the task when it
  // is closed (param unchanged) while still honoring a newly clicked task link.
  const deepLinkApplied = useRef<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Users for the Assigned by / Assignee pickers. Personal accounts have no
  // team, so the fetch is skipped for them.
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [creating, setCreating] = useState(false);
  // Whether the compose/edit form is shown in the centered modal (create, and
  // edit on boards without a drawer) or in the right-side drawer (name click on
  // drawer-enabled boards).
  const [editSurface, setEditSurface] = useState<"modal" | "drawer">("modal");
  const [view, setView] = useState<"list" | "grid">(() => {
    const saved = window.localStorage.getItem(
      `wayve.${config.storageKey}.view`
    );
    return saved === "grid" ? "grid" : "list";
  });
  // "tasks" is the default list/grid layout; "jira" is a kanban board with one
  // column per status, where dragging a card between columns changes its status.
  const [mode, setMode] = useState<"tasks" | "jira">(() => {
    const saved = window.localStorage.getItem(
      `wayve.${config.storageKey}.mode`
    );
    return saved === "jira" ? "jira" : "tasks";
  });
  // The status, priority and date filters combine, and apply to both the list
  // and the board.
  // Status filter is multi-select: an empty list means "all statuses", any
  // entries mean "only these". Priority/date stay single-choice.
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>([]);
  const toggleStatusFilter = (slug: TaskStatus) =>
    setStatusFilter((prev) =>
      prev.includes(slug)
        ? prev.filter((s) => s !== slug)
        : [...prev, slug]
    );
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all"
  );
  // `after`/`before` use one bound, `between` uses both. An empty date input
  // leaves that bound open, so the filter is a no-op until a date is chosen.
  // Bounds are inclusive whole days, in local time.
  const [dateMode, setDateMode] = useState<
    "any" | "after" | "before" | "between"
  >("any");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The status multi-select is collapsed behind a dropdown inside the popover.
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const activeFilterCount =
    (statusFilter.length > 0 ? 1 : 0) +
    (priorityFilter !== "all" ? 1 : 0) +
    (dateMode !== "any" ? 1 : 0);
  const clearFilters = () => {
    setStatusFilter([]);
    setPriorityFilter("all");
    setDateMode("any");
    setDateFrom("");
    setDateTo("");
  };
  // Column hovered during a drag, for the drop-target highlight.
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  // Table-view (☰) column sort. `null` keeps the default order (priority, then
  // oldest first). Clicking a sortable header sets the key and toggles asc/desc.
  const [sortKey, setSortKey] = useState<
    "created" | "assignee" | "priority" | "status" | null
  >(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = (key: "created" | "assignee" | "priority" | "status") => {
    if (sortKey !== key) {
      setSortKey(key);
      // Priority reads most-useful high→low first; the rest read A→Z / oldest.
      setSortDir(key === "priority" ? "desc" : "asc");
      return;
    }
    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  };

  // Close the Filters popover on outside click or Escape.
  useEffect(() => {
    if (!filtersOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        filtersRef.current &&
        e.target instanceof Node &&
        !filtersRef.current.contains(e.target)
      ) {
        setFiltersOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [filtersOpen]);

  useEffect(() => {
    window.localStorage.setItem(`wayve.${config.storageKey}.view`, view);
  }, [view, config.storageKey]);

  useEffect(() => {
    window.localStorage.setItem(`wayve.${config.storageKey}.mode`, mode);
  }, [mode, config.storageKey]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [taskName, setTaskName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);
  // Empty until the org's statuses load. The compose form's default is applied
  // once they arrive (see the effect below) rather than guessed here, since
  // there is no longer a slug that is guaranteed to exist.
  const [status, setStatus] = useState<TaskStatus>("");
  const [assignedBy, setAssignedBy] = useState("");
  const [assignee, setAssignee] = useState("");
  // `assigneeId` is set only when a real member is picked, not for a hand-typed
  // email.
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [suggestions, setSuggestions] = useState<AssigneeSuggestion[] | null>(
    null
  );
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [suggestUsedAi, setSuggestUsedAi] = useState(true);
  const [createAnother, setCreateAnother] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Files chosen in the modal but not yet uploaded. Held locally so creation can
  // persist them once the new task id exists.
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<
    TaskAttachment[]
  >([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The compact form folds assignee picking (autocomplete + code-history
  // suggestions) into a popover behind an "Assignee" pill.
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const assigneePickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!assigneePickerOpen) return;
    const onDocPointer = (event: MouseEvent) => {
      if (
        assigneePickerRef.current &&
        !assigneePickerRef.current.contains(event.target as Node)
      ) {
        setAssigneePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    return () => document.removeEventListener("mousedown", onDocPointer);
  }, [assigneePickerOpen]);

  const isEditing = editingId !== null;

  // The assignee pill shows the picked teammate's name + avatar when the
  // stored email matches an assignable user, else the raw stored value.
  const assigneeUser =
    assignableUsers.find(
      (u) => u.email.toLowerCase() === assignee.trim().toLowerCase()
    ) ?? null;

  // The org's configured statuses, in board order. Everything status-shaped on
  // this page — the board columns, the filter, the selects, the colours — is
  // derived from this list rather than from a hardcoded set.
  const [statusRows, setStatusRows] = useState<TaskStatusRow[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        setStatusRows(await getTaskStatuses());
      } catch {
        // A failure here leaves the board grouped by whatever slugs the tasks
        // themselves carry (via UNKNOWN_STATUS), which still renders. Tasks
        // failing to load is the error worth surfacing, not this.
      }
    })();
  }, []);

  const statusBySlug = useMemo(() => {
    const map = new Map<string, TaskStatusRow>();
    for (const row of statusRows) map.set(row.slug, row);
    return map;
  }, [statusRows]);

  const lookupStatus = useCallback(
    (slug: string): TaskStatusRow =>
      statusBySlug.get(slug) ?? UNKNOWN_STATUS(slug),
    [statusBySlug]
  );

  // Per-status counts for the header summary strip (workspace boards only).
  // Counted across all loaded items (not the filtered view), matching the
  // "N total" pill, and kept in the board's status order.
  const statusSummary = useMemo(() => {
    if (!config.features.statusSummary) return [];
    const counts = new Map<string, number>();
    for (const t of tasks)
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return statusRows.map((row) => ({
      slug: row.slug,
      name: row.name,
      color: row.color,
      count: counts.get(row.slug) ?? 0,
    }));
  }, [config.features.statusSummary, tasks, statusRows]);

  // The compose form's effective status. `status` stays empty until the user
  // picks one (or an edit populates it), so the default is *derived* from the
  // loaded list rather than synced into state by an effect — writing state in an
  // effect here would cascade a second render on every load.
  const composeStatus = status || statusRows[0]?.slug || "";

  const loadTasks = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    try {
      const list = await config.api.list();
      setTasks(
        sortTasks(
          list.map((t) => ({
            ...t,
            priority: normalizePriority(t.priority),
            status: normalizeStatus(t.status, statusRows),
          }))
        )
      );
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : `Failed to load ${config.labels.lowerPlural}`
      );
    } finally {
      setLoading(false);
    }
    // `config` is a stable module constant (see TASKS_CONFIG / the stories
    // wrapper), so listing it never re-creates this callback.
  }, [config]);

  // "Find related": ask Claude to label duplicate/similar tickets, then reload
  // so the new relationship pills show. Best-effort; errors surface in-line.
  const [relatedBusy, setRelatedBusy] = useState(false);
  const [relatedMsg, setRelatedMsg] = useState("");
  const runFindRelated = useCallback(async () => {
    if (!config.api.findRelated) return;
    setRelatedBusy(true);
    setRelatedMsg("");
    try {
      const r = await config.api.findRelated();
      setRelatedMsg(
        r.duplicates + r.similar === 0
          ? "No duplicates or similar tickets found."
          : `Flagged ${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"} and ${r.similar} similar.`
      );
      await loadTasks();
    } catch (err) {
      setRelatedMsg(
        err instanceof Error ? err.message : "Couldn't analyse tickets."
      );
    } finally {
      setRelatedBusy(false);
    }
  }, [config, loadTasks]);

  // "Fix with AI": dispatch the Claude Code CI fixer for the ticket being edited.
  // The fix runs in GitHub Actions and opens a PR — this just kicks it off.
  const [aiFixBusy, setAiFixBusy] = useState(false);
  const [aiFixMsg, setAiFixMsg] = useState("");
  const runAiFix = useCallback(
    async (id: number) => {
      if (!config.api.aiFix) return;
      setAiFixBusy(true);
      setAiFixMsg("");
      try {
        const r = await config.api.aiFix(id);
        setAiFixMsg(
          r.reused_fix_from
            ? `Fix started in CI (reusing the fix from #${r.reused_fix_from}). Open the ticket to review the diff.`
            : "Fix started in CI. Open the ticket to review the diff."
        );
      } catch (err) {
        setAiFixMsg(
          err instanceof Error ? err.message : "Couldn't start the AI fix."
        );
      } finally {
        setAiFixBusy(false);
      }
    },
    [config]
  );

  // The load is deferred to a timeout so the effect body doesn't synchronously
  // call setState, which React 19 flags as a cascading-render risk.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks]);

  useEffect(() => {
    if (isPersonal) return;
    let alive = true;
    getAssignableUsers()
      .then((list) => {
        if (alive) setAssignableUsers(list);
      })
      .catch(() => {
        // Non-fatal: the pickers fall back to plain text inputs.
      });
    return () => {
      alive = false;
    };
  }, [isPersonal]);

  // The selected project links the task to a repo, which drives the assignee
  // suggestions.
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

  // The backend ranks assignees from the selected project's code history.
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
        res.note ??
          (res.candidates.length === 0 ? "No suggestions found." : null)
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

  // Connected members become the real assignee, with an id. Reference-only
  // contributors only fill the free-text field.
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
    // New tasks are attributed to their creator. Personal accounts leave this
    // unset, since the task is implicitly self-owned.
    setAssignedBy(isPersonal ? "" : (user?.email ?? ""));
    setAssignee("");
    setAssigneeId(null);
    setProjectId(null);
    clearSuggestions();
    setEditingId(null);
    setError("");
    setPendingAttachments([]);
    setExistingAttachments([]);
    setAssigneePickerOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeForm = () => {
    resetForm();
    setCreateAnother(false);
    setCreating(false);
    if (openedFromDeepLink.current) {
      openedFromDeepLink.current = false;
      navigate("/chat");
    }
  };

  const openCreate = () => {
    openedFromDeepLink.current = false;
    resetForm();
    setEditSurface("modal");
    setCreating(true);
  };

  // Populate the edit form for `task` and show it on the given surface (the
  // centered modal, or the right-side drawer). Shared by name-click and the
  // Edit button.
  const beginEdit = (task: Task, surface: "modal" | "drawer") => {
    // A normal open is not a deep-link open. The deep-link effect re-sets this
    // flag after it calls the editor.
    openedFromDeepLink.current = false;
    setEditingId(task.id);
    setTaskName(task.name);
    setDescription(task.description);
    setPriority(normalizePriority(task.priority));
    setStatus(normalizeStatus(task.status, statusRows));
    setAssignedBy(task.assigned_by ?? "");
    setAssignee(task.assignee ?? "");
    setAssigneeId(task.assignee_id ?? null);
    setProjectId(task.project_id ?? null);
    setError("");
    setCreateAnother(false);
    setPendingAttachments([]);
    setExistingAttachments([]);
    setEditSurface(surface);
    setCreating(true);
    if (config.features.attachments && config.api.listAttachments) {
      setAttachmentsLoading(true);
      config.api
        .listAttachments(task.id)
        .then((list) => setExistingAttachments(list))
        .catch(() => {
          // Non-fatal — just leave the list empty.
        })
        .finally(() => setAttachmentsLoading(false));
    }
  };

  // Clicking an item's *name*: a quick edit in the right-side drawer when the
  // board opts in, else the full page (detailPath), else the modal.
  const openDetail = (task: Task) => {
    if (config.detailDrawer) {
      beginEdit(task, "drawer");
      return;
    }
    if (config.detailPath) {
      navigate(config.detailPath(task.id));
      return;
    }
    beginEdit(task, "modal");
  };

  // Clicking the Edit button: the full page when the board has one, else the
  // modal. Never the drawer — Edit is the "open the full editor" affordance.
  const openEditor = (task: Task) => {
    if (config.detailPath) {
      navigate(config.detailPath(task.id));
      return;
    }
    beginEdit(task, "modal");
  };

  const copyTaskLink = (task: Task) => {
    void navigator.clipboard?.writeText(taskShareText(task)).then(() => {
      setCopiedTaskId(task.id);
      window.setTimeout(
        () => setCopiedTaskId((id) => (id === task.id ? null : id)),
        1500
      );
    });
  };

  // Open the target task once tasks have loaded. `task` is the database id, used
  // by legacy URLs; `ref` is the #<n> from a copied task snippet (task_number,
  // falling back to id). An already-opened value is skipped so closing the task
  // doesn't reopen it.
  useEffect(() => {
    if (loading) return;
    const taskParam = searchParams.get("task");
    const refParam = searchParams.get("ref");
    if (!taskParam && !refParam) return;
    const rawKey = taskParam != null ? `id:${taskParam}` : `ref:${refParam}`;
    if (deepLinkApplied.current === rawKey) return;
    const n = Number(taskParam ?? refParam);
    if (!Number.isFinite(n)) return;
    const target =
      taskParam != null
        ? tasks.find((t) => t.id === n)
        : (tasks.find((t) => t.task_number === n) ??
          tasks.find((t) => t.id === n));
    if (!target) return;
    deepLinkApplied.current = rawKey;
    // Deferred for the same React 19 cascading-render reason as loadTasks above.
    const timer = window.setTimeout(() => {
      openEditor(target);
      openedFromDeepLink.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, tasks, searchParams]);

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    const next = Array.from(list);
    if (next.length === 0) return;
    setPendingAttachments((prev) => [...prev, ...next]);
    // Reset the input so the same filename can be picked again after removal.
    event.target.value = "";
  };

  const removePending = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const removeExisting = async (attachment: TaskAttachment) => {
    const ok = window.confirm(`Remove attachment "${attachment.name}"?`);
    if (!ok || !config.api.deleteAttachment) return;
    try {
      await config.api.deleteAttachment(attachment.id);
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
    if (!config.api.downloadAttachment) return;
    try {
      await config.api.downloadAttachment(attachment);
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
    // Flip optimistically and roll back on failure: request-then-update lag is
    // jarring when the user toggles status repeatedly.
    const prev = tasks;
    setTasks((current) =>
      sortTasks(
        current.map((t) =>
          t.id === task.id ? { ...t, status: nextStatus } : t
        )
      )
    );
    try {
      const updated = await config.api.update(task.id, {
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
                  status: normalizeStatus(updated.status, statusRows),
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

  // The card badge key is the project name's first three letters plus the
  // per-user task number ("wayve" + 12 → "way12"), falling back to "#12" when
  // the task has no resolvable project.
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
      await config.api.remove(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      if (editingId === task.id) {
        resetForm();
        setCreating(false);
      }
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : `Failed to delete ${config.labels.lowerSingular}`
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

  // Empty bounds are treated as open, and "after"/"before" ignore the unused
  // bound.
  const inDateRange = useCallback(
    (t: Task) => {
      if (dateMode === "any") return true;
      const created = new Date(t.created_at ?? 0).getTime();
      if (Number.isNaN(created)) return false;
      if ((dateMode === "after" || dateMode === "between") && dateFrom) {
        if (created < new Date(`${dateFrom}T00:00:00`).getTime()) return false;
      }
      if ((dateMode === "before" || dateMode === "between") && dateTo) {
        if (created > new Date(`${dateTo}T23:59:59.999`).getTime())
          return false;
      }
      return true;
    },
    [dateMode, dateFrom, dateTo]
  );

  const filteredTasks = useMemo(
    () =>
      visibleTasks.filter(
        (t) =>
          (statusFilter.length === 0 || statusFilter.includes(t.status)) &&
          (priorityFilter === "all" || t.priority === priorityFilter) &&
          inDateRange(t)
      ),
    [visibleTasks, statusFilter, priorityFilter, inDateRange]
  );

  const activeTasks = useMemo(
    // "Active" is every task whose status sits in a non-terminal category, not
    // the literal slug "done" — a renamed or extra completion status (or a
    // Canceled one) must not keep showing up as outstanding work.
    () =>
      filteredTasks.filter(
        (t) => !isTerminalCategory(lookupStatus(t.status).category)
      ),
    [filteredTasks]
  );

  const completedTasks = useMemo(
    () =>
      filteredTasks.filter((t) =>
        isTerminalCategory(lookupStatus(t.status).category)
      ),
    [filteredTasks]
  );

  const saveTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = taskName.trim();
    const details = description.trim();

    if (!name) {
      setError(`${config.labels.singular} name is required`);
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      let targetTaskId: number;
      if (editingId !== null) {
        const updated = await config.api.update(editingId, {
          name,
          description: details,
          priority,
          status: composeStatus,
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
                    status: normalizeStatus(updated.status, statusRows),
                  }
                : t
            )
          )
        );
      } else {
        const created = await config.api.create({
          name,
          description: details,
          priority,
          status: composeStatus,
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
              status: normalizeStatus(created.status, statusRows),
            },
          ])
        );
      }

      if (
        config.features.attachments &&
        config.api.uploadAttachments &&
        pendingAttachments.length > 0
      ) {
        try {
          await config.api.uploadAttachments(targetTaskId, pendingAttachments);
        } catch (err) {
          // The task is already saved, so keep the modal open and let the user
          // retry just the upload.
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
      setError(
        err instanceof Error
          ? err.message
          : `Failed to save ${config.labels.lowerSingular}`
      );
    } finally {
      setSubmitting(false);
    }
  };

  // The list view (☰) renders as an aligned, column-based table on the full
  // page — the same shape a logs/observability table has: header row, one row
  // per item, subtle dividers and per-row hover. A split pane is too narrow for
  // columns, so it keeps the stacked cards + inline expand. Grid view (⊞) keeps
  // the card layout.
  const useTable = view === "list" && !inSplitPane;
  // The Assignee column is a team feature; personal boards drop it (and its
  // grid column) entirely.
  const showAssignee = !isPersonal;
  const tableCols = showAssignee
    ? "124px minmax(0, 1fr) 176px 64px 168px 128px"
    : "124px minmax(0, 1fr) 64px 168px 128px";

  // The team member behind a task's assignee email, for the Assignee column.
  // Falls back to the raw stored value (silhouette avatar) when it isn't a
  // known member, and null when unassigned.
  const assigneeInfo = (
    task: Task
  ): { name: string; userId: number | null } | null => {
    const email = (task.assignee ?? "").trim();
    if (!email) return null;
    const match = assignableUsers.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    return {
      name: match?.username || email,
      userId: match?.user_id ?? task.assignee_id ?? null,
    };
  };

  // Applies the active column sort to a table row list. A stable base order is
  // assumed (the caller passes the already-sorted active/completed lists), so an
  // equal comparison preserves it.
  const sortForTable = (list: Task[]): Task[] => {
    if (!sortKey) return list;
    const dir = sortDir === "asc" ? 1 : -1;
    const keyOf = (t: Task): string | number => {
      switch (sortKey) {
        case "created":
          return new Date(t.created_at ?? 0).getTime();
        case "priority":
          return t.priority;
        case "assignee":
          return (assigneeInfo(t)?.name ?? "").toLowerCase();
        case "status":
          return lookupStatus(t.status).name.toLowerCase();
      }
    };
    return [...list].sort((a, b) => {
      const va = keyOf(a);
      const vb = keyOf(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  };

  // Direction glyph for a header: a faint up/down when inactive, a solid arrow
  // for the active column.
  const sortArrow = (key: "created" | "assignee" | "priority" | "status") => {
    if (sortKey !== key) return "↕";
    return sortDir === "asc" ? "↑" : "↓";
  };

  const sortHeader = (
    key: "created" | "assignee" | "priority" | "status",
    label: string,
    extra = ""
  ) => (
    <button
      type="button"
      className={`task-th task-th--sort${extra ? ` ${extra}` : ""}${
        sortKey === key ? " is-active" : ""
      }`}
      onClick={() => toggleSort(key)}
      aria-label={`Sort by ${label.toLowerCase()}${
        sortKey === key
          ? sortDir === "asc"
            ? " (ascending)"
            : " (descending)"
          : ""
      }`}
    >
      {label}
      <span className="task-th-arrow" aria-hidden="true">
        {sortArrow(key)}
      </span>
    </button>
  );

  // The table's column headers, reused above the active and completed rows.
  const tableHead = (
    <div className="task-thead" role="row">
      {sortHeader("created", "Created", "task-th--created")}
      <div className="task-th task-th--title">{config.labels.singular}</div>
      {showAssignee && sortHeader("assignee", "Assignee", "task-th--assignee")}
      {sortHeader("priority", "Priority", "task-th--center")}
      {sortHeader("status", "Status")}
      <div className="task-th task-th--actions" />
    </div>
  );

  // One table row. `completed` dims the row and strikes the title, mirroring the
  // completed-card treatment.
  const renderRow = (task: Task, completed: boolean) => {
    const who = showAssignee ? assigneeInfo(task) : null;
    const st = lookupStatus(task.status);
    return (
      <div
        key={task.id}
        className={`task-trow${completed ? " task-trow--completed" : ""}`}
        role="row"
      >
        <div className="task-tcell task-tcell--created">
          {formatCreatedDate(task.created_at) || "—"}
        </div>

        <div className="task-tcell task-tcell--title">
          <TaskKeyBadge
            value={taskKey(task)}
            tooltip={config.labels.numberBadgeTooltip}
          />
          <button
            type="button"
            className="task-card-title-link task-trow-title"
            onClick={() => openDetail(task)}
            data-tooltip={`Open ${config.labels.lowerSingular} details`}
          >
            {task.name}
          </button>
          <TaskBadge kind={task.badge_kind} />
          <JiraBadge task={task} />
          <GitlabBadge task={task} />
          <CopyLinkButton
            copied={copiedTaskId === task.id}
            onCopy={() => copyTaskLink(task)}
            label={task.name}
          />
        </div>

        {showAssignee && (
          <div className="task-tcell task-tcell--assignee">
            {who ? (
              <>
                <Avatar
                  name={who.name}
                  src={
                    who.userId
                      ? `${getApiBase()}/api/users/${who.userId}/avatar`
                      : undefined
                  }
                  size={22}
                />
                <span className="task-trow-assignee-name">{who.name}</span>
              </>
            ) : (
              <span className="task-trow-muted">Unassigned</span>
            )}
          </div>
        )}

        <div className="task-tcell task-tcell--priority">
          <span
            className={`task-priority-badge priority-${task.priority}`}
            data-tooltip={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
          >
            P{task.priority}
          </span>
        </div>

        <div className="task-tcell task-tcell--status">
          <TaskStatusIcon category={st.category} color={st.color} />
          <select
            className="task-status-select"
            style={{
              borderColor: st.color,
              color: st.color,
              backgroundColor: `${st.color}1a`,
            }}
            value={task.status}
            onChange={(event) =>
              void changeStatus(task, event.target.value as TaskStatus)
            }
            aria-label={`Status of ${task.name}`}
          >
            {statusRows.map((row) => (
              <option key={row.id} value={row.slug}>
                {row.name}
              </option>
            ))}
          </select>
        </div>

        <div className="task-tcell task-tcell--actions">
          <button
            type="button"
            className="task-edit-btn"
            onClick={() => openEditor(task)}
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
    );
  };

  // Loading / error / empty states, shared by the table and card layouts. Null
  // means "render the actual rows".
  const listPlaceholder = loading ? (
    <div className="tasks-empty">
      <strong>{`Loading ${config.labels.lowerPlural}…`}</strong>
    </div>
  ) : loadError ? (
    <div className="tasks-empty">
      <strong>{`Couldn't load ${config.labels.lowerPlural}`}</strong>
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
        {tasks.length === 0
          ? `No ${config.labels.lowerPlural} yet`
          : `No matching ${config.labels.lowerPlural}`}
      </strong>
      <span>
        {tasks.length === 0
          ? `Use ${config.labels.createButton} to add your first ${config.labels.lowerSingular}.`
          : "Try a different search term."}
      </span>
    </div>
  ) : activeTasks.length === 0 ? (
    <div className="tasks-empty">
      <strong>All caught up</strong>
      <span>
        Every {config.labels.lowerSingular} is done. See the completed section
        below.
      </span>
    </div>
  ) : null;

  return (
    <div className={`tasks-app${isPersonal ? " tasks-app--personal" : ""}`}>
      <main className="tasks-main">
        {inSplitPane ? (
          <button
            className="create-task-btn create-task-btn--split"
            onClick={openCreate}
          >
            {config.labels.createButton}
          </button>
        ) : (
          <>
            <div className="tasks-header">
              <div>
                <h2>{config.labels.title}</h2>
                <p>{config.labels.subtitle}</p>
              </div>
              <div className="tasks-header-actions">
                {/* Boards with the status strip below show the total there, so the
                  header pill would just duplicate it. */}
                {!config.features.statusSummary && (
                  <span className="tasks-count">{tasks.length} total</span>
                )}
                {config.features.findRelated && config.api.findRelated && (
                  <button
                    type="button"
                    className="tasks-find-related"
                    onClick={runFindRelated}
                    disabled={relatedBusy}
                    data-tooltip="Let Claude flag duplicate & similar tickets"
                  >
                    {relatedBusy ? "Analysing…" : "🔗 Find related"}
                  </button>
                )}
                {relatedMsg && (
                  <span className="tasks-find-related-msg" role="status">
                    {relatedMsg}
                  </span>
                )}
                <div className="tasks-filters" ref={filtersRef}>
                  <button
                    type="button"
                    className={`tasks-status-filter tasks-filters-btn${
                      activeFilterCount > 0 ? " has-active" : ""
                    }`}
                    onClick={() => setFiltersOpen((open) => !open)}
                    aria-haspopup="dialog"
                    aria-expanded={filtersOpen}
                    data-tooltip={config.labels.filtersTooltip}
                  >
                    <span className="tasks-filters-caret" aria-hidden="true">
                      ⌄
                    </span>
                    <span>Filters</span>
                    {activeFilterCount > 0 && (
                      <span className="tasks-filters-badge">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                  {filtersOpen && (
                    <div
                      className="tasks-filters-popover"
                      role="dialog"
                      aria-label={config.labels.filtersAria}
                    >
                      <div className="tasks-filter-row">
                        <span>Status</span>
                        <div className="tasks-filter-dropdown">
                          <button
                            type="button"
                            className="tasks-filter-dropdown-btn"
                            onClick={() =>
                              setStatusMenuOpen((open) => !open)
                            }
                            aria-haspopup="true"
                            aria-expanded={statusMenuOpen}
                          >
                            <span className="tasks-filter-dropdown-value">
                              {statusFilter.length === 0
                                ? "All statuses"
                                : statusFilter.length === 1
                                  ? lookupStatus(statusFilter[0]).name
                                  : `${statusFilter.length} selected`}
                            </span>
                            <span
                              className="tasks-filter-dropdown-caret"
                              aria-hidden="true"
                            >
                              ⌄
                            </span>
                          </button>
                          {statusMenuOpen && (
                            <div className="tasks-filter-menu">
                              <div
                                className="tasks-filter-checks"
                                role="group"
                                aria-label="Filter by status"
                              >
                                {statusRows.map((row) => (
                                  <label
                                    key={row.id}
                                    className="tasks-filter-check"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={statusFilter.includes(row.slug)}
                                      onChange={() =>
                                        toggleStatusFilter(row.slug)
                                      }
                                    />
                                    <span
                                      className="tss-dot"
                                      style={{ background: row.color }}
                                      aria-hidden="true"
                                    />
                                    <span className="tasks-filter-check-name">
                                      {row.name}
                                    </span>
                                  </label>
                                ))}
                              </div>
                              {statusFilter.length > 0 && (
                                <button
                                  type="button"
                                  className="tasks-filter-multi-clear"
                                  onClick={() => setStatusFilter([])}
                                >
                                  Clear selection
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <label className="tasks-filter-row">
                        <span>Priority</span>
                        <select
                          value={priorityFilter}
                          onChange={(e) =>
                            setPriorityFilter(
                              e.target.value === "all"
                                ? "all"
                                : (Number(e.target.value) as TaskPriority)
                            )
                          }
                          aria-label="Filter by priority"
                        >
                          <option value="all">All priorities</option>
                          {PRIORITY_OPTIONS.map((value) => (
                            <option key={value} value={value}>
                              {`P${value} — ${priorityLabel(value)}`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="tasks-filter-row">
                        <span>Created</span>
                        <select
                          value={dateMode}
                          onChange={(e) =>
                            setDateMode(
                              e.target.value as
                                | "any"
                                | "after"
                                | "before"
                                | "between"
                            )
                          }
                          aria-label="Filter by date created"
                        >
                          <option value="any">Any date</option>
                          <option value="after">Created after…</option>
                          <option value="before">Created before…</option>
                          <option value="between">Created between…</option>
                        </select>
                      </label>
                      {(dateMode === "after" || dateMode === "between") && (
                        <label className="tasks-filter-row">
                          <span>
                            {dateMode === "between" ? "From" : "On or after"}
                          </span>
                          <input
                            type="date"
                            value={dateFrom}
                            max={
                              dateMode === "between" && dateTo
                                ? dateTo
                                : undefined
                            }
                            onChange={(e) => setDateFrom(e.target.value)}
                            aria-label={
                              dateMode === "between"
                                ? "From date"
                                : "Created on or after"
                            }
                          />
                        </label>
                      )}
                      {(dateMode === "before" || dateMode === "between") && (
                        <label className="tasks-filter-row">
                          <span>
                            {dateMode === "between" ? "To" : "On or before"}
                          </span>
                          <input
                            type="date"
                            value={dateTo}
                            min={
                              dateMode === "between" && dateFrom
                                ? dateFrom
                                : undefined
                            }
                            onChange={(e) => setDateTo(e.target.value)}
                            aria-label={
                              dateMode === "between"
                                ? "To date"
                                : "Created on or before"
                            }
                          />
                        </label>
                      )}
                      <div className="tasks-filters-footer">
                        <button
                          type="button"
                          className="tasks-filters-clear"
                          onClick={clearFilters}
                          disabled={activeFilterCount === 0}
                        >
                          Clear all
                        </button>
                        <button
                          type="button"
                          className="tasks-filters-done"
                          onClick={() => setFiltersOpen(false)}
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div
                  className="view-toggle"
                  role="group"
                  aria-label="View mode"
                >
                  <button
                    type="button"
                    className={`view-toggle-btn${mode === "tasks" && view === "list" ? " active" : ""}`}
                    onClick={() => {
                      setMode("tasks");
                      setView("list");
                    }}
                    aria-pressed={mode === "tasks" && view === "list"}
                    aria-label="List view"
                    data-tooltip="List view"
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
                    data-tooltip="Grid view"
                  >
                    ⊞
                  </button>
                  <button
                    type="button"
                    className={`view-toggle-btn${mode === "jira" ? " active" : ""}`}
                    onClick={() => setMode("jira")}
                    aria-pressed={mode === "jira"}
                    aria-label="Columns (Jira board) view"
                    data-tooltip="Columns (Jira board) view"
                  >
                    ◫
                  </button>
                </div>
                <button
                  className="create-task-btn create-task-btn--inline"
                  onClick={openCreate}
                >
                  {config.labels.createButton}
                </button>
              </div>
            </div>
            {config.features.statusSummary && statusSummary.length > 0 && (
              <div
                className="tasks-status-summary"
                aria-label="Status breakdown"
              >
                <span className="tss-chip tss-total">
                  <b>{tasks.length}</b> total
                </span>
                {statusSummary.map((s) => (
                  <span className="tss-chip" key={s.slug} title={s.name}>
                    <span
                      className="tss-dot"
                      style={{ background: s.color }}
                      aria-hidden="true"
                    />
                    {s.name} <b>{s.count}</b>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <EditSurface
          surface={editSurface}
          isOpen={creating}
          onClose={closeForm}
          title={
            isEditing ? config.labels.editTitle : config.labels.createTitle
          }
          onExpand={
            isEditing && editingId !== null && config.detailPath
              ? () => {
                  const id = editingId;
                  closeForm();
                  if (config.detailPath) navigate(config.detailPath(id));
                }
              : undefined
          }
        >
          <form className="task-compose" onSubmit={saveTask}>
            <input
              className="task-compose-title"
              value={taskName}
              onChange={(event) => setTaskName(event.target.value)}
              placeholder={config.labels.namePlaceholder}
              aria-label={config.labels.namePlaceholder}
              autoFocus
              required
            />

            <textarea
              className="task-compose-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add description…"
              aria-label="Task description"
            />

            <div className="task-compose-pills">
              <label
                className="task-pill"
                data-tooltip={
                  isEditing ? "Status" : "Initial status upon creation"
                }
              >
                {/* Colour comes from the status row, not a per-status CSS
                    class — a user-defined status has no class to key off. */}
                <span
                  className="task-pill-dot"
                  style={{ backgroundColor: lookupStatus(composeStatus).color }}
                  aria-hidden="true"
                />
                <select
                  className="task-pill-select"
                  value={composeStatus}
                  aria-label="Status"
                  onChange={(event) =>
                    setStatus(event.target.value as TaskStatus)
                  }
                >
                  {statusRows.map((row) => (
                    <option key={row.id} value={row.slug}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="task-pill" data-tooltip="Priority">
                <svg
                  className="task-pill-icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="9" width="3" height="5.5" rx="1" />
                  <rect x="6.5" y="5.5" width="3" height="9" rx="1" />
                  <rect x="11.5" y="2" width="3" height="12.5" rx="1" />
                </svg>
                <select
                  className="task-pill-select"
                  value={priority}
                  aria-label="Priority"
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

              <label
                className="task-pill"
                data-tooltip="Project — used to suggest assignees from its code history"
              >
                <svg
                  className="task-pill-icon task-pill-icon--stroke"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path d="M8 1.5l5.5 3v7l-5.5 3-5.5-3v-7l5.5-3z" />
                  <path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v6.5" />
                </svg>
                <select
                  className="task-pill-select"
                  value={projectId ?? ""}
                  aria-label="Project"
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
              </label>

              {/* Assignment is a team feature, so only organization accounts
                    see it. "Assigned by" is never shown, since a task is
                    always attributed to its creator. */}
              {!isPersonal && (
                <div className="task-pill-wrap" ref={assigneePickerRef}>
                  <button
                    type="button"
                    className="task-pill task-pill--button"
                    onClick={() => setAssigneePickerOpen((open) => !open)}
                    aria-expanded={assigneePickerOpen}
                    aria-haspopup="dialog"
                  >
                    {assigneeUser ? (
                      <Avatar
                        name={assigneeUser.username || assigneeUser.email}
                        src={`${getApiBase()}/api/users/${assigneeUser.user_id}/avatar`}
                        size={16}
                      />
                    ) : (
                      <svg
                        className="task-pill-icon task-pill-icon--stroke"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                      >
                        <circle cx="8" cy="5.5" r="2.8" />
                        <path d="M2.5 14c.8-2.8 3-4.2 5.5-4.2s4.7 1.4 5.5 4.2" />
                      </svg>
                    )}
                    <span className="task-pill-text">
                      {assigneeUser?.username || assignee.trim() || "Assignee"}
                    </span>
                  </button>

                  {assigneePickerOpen && (
                    <AssigneeMenu
                      users={assignableUsers}
                      selectedEmail={assignee}
                      onClose={() => setAssigneePickerOpen(false)}
                      onSelect={(picked) => {
                        setAssignee(picked ? picked.email : "");
                        setAssigneeId(picked ? picked.user_id : null);
                        setAssigneePickerOpen(false);
                      }}
                    >
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
                    </AssigneeMenu>
                  )}
                </div>
              )}
            </div>

            {config.features.attachments && isEditing && attachmentsLoading && (
              <div className="task-attachments-empty">Loading attachments…</div>
            )}

            {config.features.attachments &&
              (existingAttachments.length > 0 ||
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
                        data-tooltip="Download"
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

            {error && <div className="task-error">{error}</div>}

            <div className="task-compose-footer">
              {config.features.attachments && (
                <>
                  <button
                    type="button"
                    className="task-compose-attach"
                    onClick={() => fileInputRef.current?.click()}
                    data-tooltip="Attach files — uploaded when you save"
                    aria-label="Attach files"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M14 7.5l-5.7 5.7a3.4 3.4 0 01-4.8-4.8L9.2 2.7a2.3 2.3 0 013.2 3.2L6.7 11.6a1.1 1.1 0 01-1.6-1.6l5.3-5.3" />
                    </svg>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="task-attachments-input"
                    onChange={onPickFiles}
                  />
                </>
              )}

              <div className="task-compose-footer-right">
                {!isEditing && (
                  <label className="task-compose-more">
                    <input
                      type="checkbox"
                      checked={createAnother}
                      onChange={(event) =>
                        setCreateAnother(event.target.checked)
                      }
                    />
                    <span className="task-compose-switch" aria-hidden="true" />
                    <span>Create more</span>
                  </label>
                )}
                {isEditing &&
                  editingId !== null &&
                  config.features.aiFix &&
                  config.api.aiFix &&
                  // The AI fixer is limited to P5 tickets for now; the backend
                  // enforces the same gate.
                  priority === 5 && (
                    <button
                      type="button"
                      className="task-ai-fix-btn"
                      onClick={() => void runAiFix(editingId)}
                      disabled={aiFixBusy}
                      data-tooltip="Have Claude propose a fix in CI, then review the diff on the ticket"
                    >
                      {aiFixBusy ? "Starting…" : "Fix with AI"}
                    </button>
                  )}
                <button type="submit" className="primary" disabled={submitting}>
                  {submitting
                    ? isEditing
                      ? "Saving…"
                      : "Creating…"
                    : isEditing
                      ? "Save changes"
                      : `Create ${config.labels.lowerSingular}`}
                </button>
              </div>
              {aiFixMsg && (
                <p className="task-ai-fix-msg" role="status">
                  {aiFixMsg}
                </p>
              )}
            </div>
          </form>
        </EditSurface>

        {mode === "jira" ? (
          loading ? (
            <div className="tasks-empty">
              <strong>{`Loading ${config.labels.lowerPlural}…`}</strong>
            </div>
          ) : loadError ? (
            <div className="tasks-empty">
              <strong>{`Couldn't load ${config.labels.lowerPlural}`}</strong>
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
              {statusRows.map((col) => {
                const colTasks = filteredTasks.filter(
                  (t) => t.status === col.slug
                );
                return (
                  <section
                    key={col.id}
                    // The terminal modifier drives the struck-through card title,
                    // and is keyed to the category so a renamed completion
                    // status keeps the treatment.
                    className={`task-board-col${
                      isTerminalCategory(col.category)
                        ? " task-board-col--terminal"
                        : ""
                    }${
                      dragOverStatus === col.slug
                        ? " task-board-col--dragover"
                        : ""
                    }`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (dragOverStatus !== col.slug)
                        setDragOverStatus(col.slug);
                    }}
                    onDragLeave={(event) => {
                      // Only clear when the pointer actually leaves the column,
                      // not when it crosses onto a child card.
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        setDragOverStatus((s) => (s === col.slug ? null : s));
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOverStatus(null);
                      const id = Number(
                        event.dataTransfer.getData("text/plain")
                      );
                      const dropped = tasks.find((t) => t.id === id);
                      if (dropped) void changeStatus(dropped, col.slug);
                    }}
                  >
                    <header className="task-board-col-header">
                      <TaskStatusIcon
                        category={col.category}
                        color={col.color}
                        size={15}
                      />
                      <span className="task-board-col-title">{col.name}</span>
                      <span className="task-board-col-count">
                        {colTasks.length}
                      </span>
                    </header>
                    <div className="task-board-col-body">
                      {colTasks.length === 0 ? (
                        <div className="task-board-empty">
                          No {config.labels.lowerPlural}
                        </div>
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
                                data-tooltip={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
                              >
                                P{task.priority}
                              </span>
                              <TaskKeyBadge
                                value={taskKey(task)}
                                tooltip={config.labels.numberBadgeTooltip}
                              />
                              <CopyLinkButton
                                copied={copiedTaskId === task.id}
                                onCopy={() => copyTaskLink(task)}
                                label={task.name}
                              />
                              <TaskBadge kind={task.badge_kind} />
                            </div>
                            <button
                              type="button"
                              className="task-card-title-link task-board-card-title"
                              onClick={() => openDetail(task)}
                              data-tooltip={`Open ${config.labels.lowerSingular} details`}
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
                                onClick={() => openEditor(task)}
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
            {useTable ? (
              listPlaceholder ?? (
                <div
                  className="task-table"
                  style={{ "--task-cols": tableCols } as React.CSSProperties}
                  role="table"
                >
                  {tableHead}
                  {sortForTable(activeTasks).map((task) =>
                    renderRow(task, false)
                  )}
                </div>
              )
            ) : (
              <div className={`task-list task-list--${view}`}>
                {listPlaceholder ??
                  activeTasks.map((task) => {
                  const expanded = inSplitPane && expandedId === task.id;
                  return (
                    <article
                      key={task.id}
                      className={`task-card${expanded ? " task-card--expanded" : ""}`}
                    >
                      <div className="task-card-body">
                        <div className="task-card-title">
                          <TaskKeyBadge
                            value={taskKey(task)}
                            tooltip={config.labels.numberBadgeTooltip}
                          />
                          <CopyLinkButton
                            copied={copiedTaskId === task.id}
                            onCopy={() => copyTaskLink(task)}
                            label={task.name}
                          />
                          <TaskBadge kind={task.badge_kind} />
                          <h3>
                            <button
                              type="button"
                              className="task-card-title-link"
                              onClick={() => openDetail(task)}
                              data-tooltip={`Open ${config.labels.lowerSingular} details`}
                            >
                              {task.name}
                            </button>
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                          </h3>
                          <span
                            className={`task-priority-badge priority-${task.priority}`}
                            data-tooltip={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
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
                            onClick={() => openEditor(task)}
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
                          <span className="task-status-control">
                            <TaskStatusIcon
                              category={lookupStatus(task.status).category}
                              color={lookupStatus(task.status).color}
                            />
                            {/* Tinted from the status's own colour rather than a
                                per-status class, so custom statuses are styled
                                the same way the built-in ones are. */}
                            <select
                              className="task-status-select"
                              style={{
                                borderColor: lookupStatus(task.status).color,
                                color: lookupStatus(task.status).color,
                                backgroundColor: `${lookupStatus(task.status).color}1a`,
                              }}
                              value={task.status}
                              onChange={(event) =>
                                void changeStatus(
                                  task,
                                  event.target.value as TaskStatus
                                )
                              }
                              aria-label={`Status of ${task.name}`}
                            >
                              {statusRows.map((row) => (
                                <option key={row.id} value={row.slug}>
                                  {row.name}
                                </option>
                              ))}
                            </select>
                          </span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            {!loading && !loadError && completedTasks.length > 0 && (
              <section className="task-completed-section">
                <h3 className="task-completed-title">
                  Completed
                  <span className="task-completed-count">
                    {completedTasks.length}
                  </span>
                </h3>
                {useTable ? (
                  <div
                    className="task-table"
                    style={{ "--task-cols": tableCols } as React.CSSProperties}
                    role="table"
                  >
                    {tableHead}
                    {sortForTable(completedTasks).map((task) =>
                      renderRow(task, true)
                    )}
                  </div>
                ) : (
                  <div className={`task-list task-list--${view}`}>
                    {completedTasks.map((task) => (
                    <article
                      key={task.id}
                      className="task-card task-card--completed"
                    >
                      <div className="task-card-body">
                        <div className="task-card-title">
                          <TaskKeyBadge
                            value={taskKey(task)}
                            tooltip={config.labels.numberBadgeTooltip}
                          />
                          <CopyLinkButton
                            copied={copiedTaskId === task.id}
                            onCopy={() => copyTaskLink(task)}
                            label={task.name}
                          />
                          <TaskBadge kind={task.badge_kind} />
                          <h3>
                            <button
                              type="button"
                              className="task-card-title-link"
                              onClick={() => openDetail(task)}
                              data-tooltip={`Open ${config.labels.lowerSingular} details`}
                            >
                              {task.name}
                            </button>
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                          </h3>
                          <span
                            className={`task-priority-badge priority-${task.priority}`}
                            data-tooltip={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
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
                          onClick={() => openEditor(task)}
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
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
