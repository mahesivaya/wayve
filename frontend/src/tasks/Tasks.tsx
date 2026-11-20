import {
  type CSSProperties,
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
import { Link as LinkIcon } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { taskShareText, taskShareUrl } from "./taskShareLink";
import { copyText } from "../utils/clipboard";
import { useGlobalSearch } from "../search/SearchContext";
import Modal from "../components/Modal";
import Avatar from "../components/Avatar";
import { useInSplitPane } from "../components/SplitPaneContext";
import { getApiBase } from "../config/env";
import { JiraBadge } from "./JiraPanel";
import { GitlabBadge } from "./GitlabBadge";
import TaskStatusIcon from "./TaskStatusIcon";
import FigmaLinks from "../integrations/FigmaLinks";
import AiFixPanel from "../aifix/AiFixPanel";
import { storyKey } from "../userstories/storyKey";
import type { AiFixApi } from "../api/aiFix";
import "./tasks.css";
import { displayLocale, hourOptions } from "../utils/datetime";

// P1 is the most important, P5 the least — the number *is* the rank, so the
// options read top-down in importance order.
const PRIORITY_OPTIONS: TaskPriority[] = [1, 2, 3, 4, 5];

const priorityLabel = (priority: TaskPriority) => {
  if (priority === 1) return "Highest";
  if (priority === 2) return "High";
  if (priority === 3) return "Medium";
  if (priority === 4) return "Low";
  return "Lowest";
};

// Returns "" for a missing or unparseable timestamp so the UI omits the line.
const formatCreatedAt = (value: string | null | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(displayLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...hourOptions(),
  });
};

// Date only (no time), for the table's Created column. "" when unparseable so
// the cell shows a dash.
const formatCreatedDate = (value: string | null | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(displayLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

// The list table's columns, in display order. `narrow` is the track a column
// keeps when the board pane is too narrow for every column (see the container
// query in tasks.css); a column without one drops out there. `locked` columns
// can't be hidden from the Columns menu.
export type TableColumnKey =
  | "created"
  | "key"
  | "title"
  | "type"
  | "project"
  | "assignee"
  | "reviewer"
  | "reporter"
  | "priority"
  | "status"
  | "related"
  | "updated"
  | "description";

type TableColumn = {
  key: TableColumnKey;
  label: string;
  width: string;
  narrow?: string;
  locked?: boolean;
  defaultOn: boolean;
};

const TABLE_COLUMNS: TableColumn[] = [
  // Wide enough for the copy-link icon and a key such as "SAM004".
  { key: "key", label: "Key", width: "116px", defaultOn: false },
  {
    key: "title",
    label: "Summary",
    width: "minmax(0, 1fr)",
    narrow: "minmax(0, 1fr)",
    locked: true,
    defaultOn: true,
  },
  {
    key: "type",
    label: "Type",
    width: "112px",
    narrow: "auto",
    defaultOn: true,
  },
  { key: "project", label: "Project", width: "160px", defaultOn: false },
  // Who created the task (its `assigned_by`, set automatically on create).
  // Keyed "reporter" rather than the old hidden-by-default "assigned_by"
  // column, so it shows for everyone, including boards with saved choices.
  { key: "reporter", label: "Reporter", width: "176px", defaultOn: true },
  { key: "assignee", label: "Assignee", width: "176px", defaultOn: true },
  { key: "reviewer", label: "Reviewer", width: "176px", defaultOn: true },
  {
    key: "priority",
    label: "Priority",
    width: "64px",
    narrow: "56px",
    defaultOn: true,
  },
  {
    key: "status",
    label: "Status",
    width: "168px",
    narrow: "150px",
    defaultOn: true,
  },
  { key: "created", label: "Created", width: "124px", defaultOn: true },
  { key: "related", label: "Related", width: "150px", defaultOn: false },
  { key: "updated", label: "Updated", width: "124px", defaultOn: false },
  {
    key: "description",
    label: "Description",
    width: "240px",
    defaultOn: false,
  },
];

const DEFAULT_SHOWN_COLUMNS: TableColumnKey[] = TABLE_COLUMNS.filter(
  (c) => c.defaultOn
).map((c) => c.key);

const ALL_COLUMN_KEYS: TableColumnKey[] = TABLE_COLUMNS.map((c) => c.key);

// Columns added after column choices started being saved. A choice saved
// before `colsKnown` existed is taken to predate exactly these.
const COLUMNS_ADDED_LATER: TableColumnKey[] = ["reviewer"];

const readKeyList = (storageKey: string): string[] | null => {
  const saved = window.localStorage.getItem(storageKey);
  const parsed = saved ? (JSON.parse(saved) as unknown) : null;
  return Array.isArray(parsed)
    ? parsed.filter((k): k is string => typeof k === "string")
    : null;
};

// The board's saved column choice, or the defaults. Anything unknown (a
// hand-edited value or a column a later build removed) is dropped. A saved
// choice only speaks for the columns that existed when it was made
// (`colsKnown`): a default-on column added since then is shown, rather than
// staying hidden for everyone who had already opened the board.
const loadShownColumns = (storageKey: string): TableColumnKey[] => {
  try {
    const shown = readKeyList(`wayve.${storageKey}.cols`);
    if (!shown) return DEFAULT_SHOWN_COLUMNS;
    const known =
      readKeyList(`wayve.${storageKey}.colsKnown`) ??
      ALL_COLUMN_KEYS.filter((k) => !COLUMNS_ADDED_LATER.includes(k));
    return ALL_COLUMN_KEYS.filter(
      (k) =>
        shown.includes(k) ||
        (!known.includes(k) && DEFAULT_SHOWN_COLUMNS.includes(k))
    );
  } catch {
    return DEFAULT_SHOWN_COLUMNS;
  }
};

type SortKey =
  "created" | "updated" | "assignee" | "reviewer" | "priority" | "status";

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

/**
 * Every field the compose form can write, flattened into one comparable string.
 * `beginEdit` records this for the item as it loaded; the live values are
 * re-derived each render, and Save stays disabled while the two match — an edit
 * that changes nothing is a write the API doesn't need to serve.
 *
 * Name and description are trimmed on both sides because `saveTask` trims them
 * too: trailing whitespace is not an edit. Queued attachments count as a change
 * even when no field moved; already-uploaded ones don't, since removing one
 * hits the API immediately rather than waiting for Save.
 */
type ComposeFields = {
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedBy: string;
  assignee: string;
  assigneeId: number | null;
  reviewer: string;
  reviewerId: number | null;
  projectId: number | null;
  badgeKind: string;
  pendingAttachments: number;
};

const composeFingerprint = (fields: ComposeFields) =>
  JSON.stringify({
    ...fields,
    name: fields.name.trim(),
    description: fields.description.trim(),
  });

const sortTasks = (list: Task[]) =>
  [...list].sort(
    (a, b) =>
      a.priority - b.priority ||
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

// The status <select>'s colours, from the status row so custom statuses look
// like built-in ones: a solid fill in the status's colour, labelled in white,
// or in near-black when the fill is too light for white to read (e.g. amber).
function statusSelectStyle(row: TaskStatusRow): CSSProperties {
  const label = relativeLuminance(row.color) > 0.4 ? "#111827" : "#fff";
  return { borderColor: row.color, color: label, backgroundColor: row.color };
}

// WCAG relative luminance of a #rrggbb colour, 0 (black) to 1 (white). An
// unparseable value reads as dark, so it keeps the white label.
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const channel = (i: number) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

// Linear-style assignee dropdown: the list of assignable users shows
// immediately, with a "No assignee" row on top and a checkmark on the current
// selection. A slim filter input appears only for larger teams. Extra footer
// content (the code-history suggestions) renders below the list.
function AssigneeMenu({
  users,
  selectedEmail,
  onSelect,
  onClose,
  role = "assignee",
  children,
}: {
  users: AssignableUser[];
  selectedEmail: string;
  /** `null` selects "No assignee" (or "No reviewer"). */
  onSelect: (user: AssignableUser | null) => void;
  onClose: () => void;
  /** Who is being picked; only changes the menu's wording. */
  role?: "assignee" | "reviewer";
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
      aria-label={`Choose ${role}`}
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
            <span className="task-assignee-row-name">{`No ${role}`}</span>
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
        <LinkIcon className="task-copy-link-icon" aria-hidden="true" />
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
  onOpen,
  openTooltip,
}: {
  value: string | null;
  tooltip: string;
  // Set on boards where the key, not the name, opens the item.
  onOpen?: () => void;
  openTooltip?: string;
}) {
  if (!value) return null;
  if (onOpen) {
    return (
      <button
        type="button"
        className="task-number-badge task-number-badge--link"
        onClick={onOpen}
        data-tooltip={openTooltip ?? tooltip}
      >
        {value}
      </button>
    );
  }
  return (
    <span className="task-number-badge" data-tooltip={tooltip}>
      {value}
    </span>
  );
}

// Emoji + label per ticket type, driving the "Type" column badge. The value is
// either a user-picked type or, for tickets materialised from a reported bug,
// the support category. Unknown/absent kinds render nothing, so tasks and user
// stories (which never carry a badge_kind) are unaffected.
const BADGE_KINDS: Record<string, { icon: string; label: string }> = {
  bug: { icon: "", label: "Bug" },
  feature: { icon: "✨", label: "Feature" },
  billing: { icon: "💳", label: "Billing" },
  account: { icon: "👤", label: "Account" },
  other: { icon: "📌", label: "Other" },
};

// The types a user can pick, in the ticket form and in the board's Type column.
// Same set as the support-ticket categories, so a manually typed ticket and a
// mirrored bug report render the identical badge.
const TYPE_OPTIONS = ["bug", "feature", "billing", "account", "other"] as const;

function TaskBadge({ kind }: { kind?: string | null }) {
  if (!kind) return null;
  const meta = BADGE_KINDS[kind] ?? { icon: "📌", label: kind };
  return (
    <span
      className={`ticket-kind-badge ticket-kind-${kind}`}
      data-tooltip="Ticket type"
    >
      {meta.icon ? `${meta.icon} ${meta.label}` : meta.label}
    </span>
  );
}

// The drawer's dragged width, shared by every board (one drawer is open at a
// time, and a person who wants a wide editor wants it everywhere). The floor
// keeps the head's title + buttons on one line; the ceiling leaves the board
// visible behind it.
const DRAWER_WIDTH_KEY = "rwayve.taskDrawer.width";
const DRAWER_DEFAULT_WIDTH = 460;
const DRAWER_MIN_WIDTH = 360;
const clampDrawerWidth = (px: number) =>
  Math.min(
    Math.max(px, DRAWER_MIN_WIDTH),
    Math.round(window.innerWidth * 0.95)
  );

// Hosts the compose/edit form on one of two surfaces: the centered modal (used
// for Create, and Edit on boards without a drawer) or a right-side drawer (used
// when an item's name is clicked on a drawer-enabled board). The form is passed
// as `children`, so it is written once regardless of surface. `onExpand`, when
// given, renders a button that jumps to the full page. `contained` keeps the
// drawer inside the board, so in a split pane it doesn't cover the other panes.
function EditSurface({
  surface,
  isOpen,
  onClose,
  title,
  onExpand,
  contained = false,
  children,
}: {
  surface: "modal" | "drawer";
  isOpen: boolean;
  onClose: () => void;
  title: string;
  onExpand?: () => void;
  contained?: boolean;
  children: React.ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);

  // Modal has its own ESC handling; the drawer needs its own.
  useEffect(() => {
    if (surface !== "drawer" || !isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape pressed in another pane isn't meant for a contained drawer.
      const target = event.target;
      if (
        contained &&
        target instanceof Node &&
        target !== document.body &&
        !drawerRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surface, isOpen, onClose, contained]);

  // Drag the drawer's left edge to widen it — a diff or a long description is
  // unreadable in a 460px column. Same drag mechanics as the email sidebar
  // (see Emails.tsx): a ref for the in-flight gesture so moving the mouse
  // doesn't re-subscribe, and the result persisted so it survives a reload.
  const [drawerWidth, setDrawerWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0
      ? stored
      : DRAWER_DEFAULT_WIDTH;
  });
  const draggingRef = useRef(false);

  useEffect(() => {
    if (surface !== "drawer" || !isOpen) return;
    function onMove(event: MouseEvent) {
      if (!draggingRef.current) return;
      // The drawer is pinned to the right, so its width is the gap between the
      // pointer and its own right edge. A contained drawer can't outgrow its
      // board; a fixed one has no offsetParent.
      const drawer = drawerRef.current;
      const right = drawer?.getBoundingClientRect().right ?? window.innerWidth;
      const room = drawer?.offsetParent?.clientWidth ?? Infinity;
      setDrawerWidth(Math.min(clampDrawerWidth(right - event.clientX), room));
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onUp();
    };
  }, [surface, isOpen]);

  useEffect(() => {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth));
  }, [drawerWidth]);

  // The drawer starts where the list starts, so the board's own header (title,
  // filters, view switch) stays visible above it. This component is rendered
  // in the flow right between that header and the list, so a zero-height
  // marker here is exactly that line. Measured against the drawer's positioned
  // parent, and re-measured when the parent resizes (filters can wrap).
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [drawerTop, setDrawerTop] = useState(0);

  useEffect(() => {
    if (surface !== "drawer" || !isOpen) return;
    const parent = drawerRef.current?.offsetParent;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const top =
        anchor.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      // A scrolled list puts the marker above the board; never go negative.
      setDrawerTop(Math.max(0, Math.round(top)));
    };
    // Fires once on observe, which is the initial measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [surface, isOpen]);

  if (surface === "modal") {
    return (
      <Modal contained isOpen={isOpen} onClose={onClose} title={title}>
        {children}
      </Modal>
    );
  }
  if (!isOpen) return null;
  return (
    <>
      <div
        className={`task-drawer-overlay${contained ? " task-drawer-overlay--contained" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <span ref={anchorRef} className="task-drawer-anchor" aria-hidden="true" />
      <aside
        ref={drawerRef}
        className={`task-drawer${contained ? " task-drawer--contained" : ""}`}
        role="dialog"
        aria-label={title}
        style={{
          width: clampDrawerWidth(drawerWidth),
          top: drawerTop,
          height: `calc(100% - ${drawerTop}px)`,
        }}
      >
        <div
          className="task-drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          data-tooltip="Drag to resize"
          onMouseDown={() => {
            draggingRef.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          // Double-click restores the default, so a drag that went too far
          // isn't a nuisance to undo by hand.
          onDoubleClick={() => setDrawerWidth(DRAWER_DEFAULT_WIDTH)}
        />
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

// The list view's checkbox column (boards with `rowSelect`).
const SELECT_COL_WIDTH = "20px";

export type TasksConfig = {
  api: {
    list: () => Promise<Task[]>;
    create: (payload: SaveTaskPayload) => Promise<Task>;
    update: (id: number, payload: SaveTaskPayload) => Promise<Task>;
    remove: (id: number) => Promise<void>;
    // Optional: on-demand AI pass that labels duplicate/similar tickets. Only
    // the Tickets board wires this (see api/tickets.ts).
    findRelated?: () => Promise<RelatedResult>;
    // Optional: the full AI-fix client (dispatch, diff, edit, commit/push/PR)
    // for this board's collection. Set it and the edit surface renders the
    // review panel inline. Tickets and User Stories wire it; Tasks don't.
    aiFixPanel?: AiFixApi;
    // Optional: attachment endpoints for this board's item type. Tasks hit
    // /api/tasks/…, Tickets hit /api/workspace-tickets/… — the board just calls
    // these. Only wired when `features.attachments` is on.
    listAttachments?: (id: number) => Promise<TaskAttachment[]>;
    uploadAttachments?: (
      id: number,
      files: File[]
    ) => Promise<TaskAttachment[]>;
    deleteAttachment?: (id: number) => Promise<void>;
    downloadAttachment?: (attachment: TaskAttachment) => Promise<void>;
  };
  features: {
    // File attachments on the create/edit form. Each board points the four
    // attachment calls in `api` at its own endpoints (tasks, tickets, stories).
    attachments: boolean;
    // Shows a per-status count strip above the board (total + each status). On
    // for the shared workspace boards (Tickets, User Stories).
    statusSummary?: boolean;
    // Shows the "Find related" (AI duplicate/similar) toolbar button. Tickets only.
    findRelated?: boolean;
    // Lowest priority *number* eligible for an AI fix. P1 is Highest, so this
    // is a floor: 4 lets P4 (Low) and P5 (Lowest) through, 5 only P5, 1 lets
    // everything through. Defaults to 1. The backend enforces the real gate.
    aiFixMinPriority?: number;
    // Shows a dedicated "Type" column (Bug/Feature/… badge) in the list-view
    // table instead of rendering the badge inline after the name. Tickets only.
    typeColumn?: boolean;
    // The board's items have a Reviewer (shown as a list column, and sent with
    // every save). Stories and tickets; plain tasks have no reviewer.
    reviewer?: boolean;
    // Shows the "Design" section in the editor, for attaching Figma files.
    // On for the workspace boards; personal Tasks leave it off.
    figmaLinks?: boolean;
    // The list view's table text is two pixels larger (see
    // .workspace-large-text in index.css). On for User Stories and Tickets.
    largeText?: boolean;
    // Each list-view row has a checkbox, and the header one selects them all.
    // On for User Stories and Tickets.
    rowSelect?: boolean;
    // Keys are written the story way: "SAM004", or "NON004" with no project
    // (see userstories/storyKey.ts). User Stories only; the other boards keep
    // "sam4" / "#4".
    storyKeys?: boolean;
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
  // Tickets show the badge (Bug/Feature/…) in its own "Type" column and expose
  // the field for editing; other boards keep the badge inline after the name and
  // never send a type.
  const showType = !!config.features.typeColumn;
  const largeTextClass = config.features.largeText
    ? " workspace-large-text"
    : "";
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
  // Rows ticked in the list view (boards with `rowSelect`), by item id.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set()
  );
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
  // Per-column widths for the list-view table, in px, keyed by column. Only
  // columns the user has actually dragged appear here — everything else falls
  // back to its default track, so the title keeps flexing to fill the row until
  // it is deliberately sized. Persisted per board.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = window.localStorage.getItem(
        `wayve.${config.storageKey}.colw`
      );
      const parsed = saved ? (JSON.parse(saved) as unknown) : null;
      // Anything hand-edited or written by an older build could be any shape;
      // keep only positive numbers so a bad entry can't collapse a column.
      if (!parsed || typeof parsed !== "object") return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0
        )
      ) as Record<string, number>;
    } catch {
      return {};
    }
  });

  // The status, priority and date filters combine, and apply to both the list
  // and the board.
  // Status filter is multi-select: an empty list means "all statuses", any
  // entries mean "only these". Priority/date stay single-choice.
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>([]);
  const toggleStatusFilter = (slug: TaskStatus) =>
    setStatusFilter((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
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
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Which optional list-table columns are shown, persisted per board. Locked
  // columns are always shown whatever this holds.
  const [shownCols, setShownCols] = useState<TableColumnKey[]>(() =>
    loadShownColumns(config.storageKey)
  );
  const [colsOpen, setColsOpen] = useState(false);
  const [colsQuery, setColsQuery] = useState("");
  const colsRef = useRef<HTMLDivElement>(null);
  const toggleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      // P1-first is the most useful priority order; ascending gets it, since a
      // lower number now means a higher priority. The rest read A→Z / oldest.
      setSortDir("asc");
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

  // Close the Columns menu on outside click or Escape.
  useEffect(() => {
    if (!colsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        colsRef.current &&
        e.target instanceof Node &&
        !colsRef.current.contains(e.target)
      ) {
        setColsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColsOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [colsOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        `wayve.${config.storageKey}.cols`,
        JSON.stringify(shownCols)
      );
      // Which columns this choice was made against (see loadShownColumns).
      window.localStorage.setItem(
        `wayve.${config.storageKey}.colsKnown`,
        JSON.stringify(ALL_COLUMN_KEYS)
      );
    } catch {
      // Storage unavailable: the choice just lasts for this visit.
    }
  }, [shownCols, config.storageKey]);

  useEffect(() => {
    window.localStorage.setItem(`wayve.${config.storageKey}.view`, view);
  }, [view, config.storageKey]);

  useEffect(() => {
    window.localStorage.setItem(`wayve.${config.storageKey}.mode`, mode);
  }, [mode, config.storageKey]);

  useEffect(() => {
    window.localStorage.setItem(
      `wayve.${config.storageKey}.colw`,
      JSON.stringify(colWidths)
    );
  }, [colWidths, config.storageKey]);
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
  // The form's Reviewer, on boards that have one (stories, tickets). Same
  // shape as the assignee: a member's address plus their id.
  const [reviewer, setReviewer] = useState("");
  const [reviewerId, setReviewerId] = useState<number | null>(null);
  const [reviewerPickerOpen, setReviewerPickerOpen] = useState(false);
  const reviewerPickerRef = useRef<HTMLDivElement | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  // The edit modal's Type field, only used on the Tickets board (one of
  // TYPE_OPTIONS; "" = no type). Bug-derived tickets keep their support category
  // server-side regardless of what is picked here.
  const [badgeKind, setBadgeKind] = useState<string>("");
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
  // The form as `beginEdit` loaded it, so Save can tell an untouched editor from
  // an edited one. State rather than a ref because the comparison happens during
  // render, and refs must not be read there. Null while creating — Create is
  // never gated on this.
  const [pristineForm, setPristineForm] = useState<string | null>(null);
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

  useEffect(() => {
    if (!reviewerPickerOpen) return;
    const onDocPointer = (event: MouseEvent) => {
      if (
        reviewerPickerRef.current &&
        !reviewerPickerRef.current.contains(event.target as Node)
      ) {
        setReviewerPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    return () => document.removeEventListener("mousedown", onDocPointer);
  }, [reviewerPickerOpen]);

  const isEditing = editingId !== null;
  // The open item, for the form's Delete button (rows no longer carry one).
  const editingTask = isEditing
    ? (tasks.find((t) => t.id === editingId) ?? null)
    : null;

  // Has anything actually moved since the editor opened? Compared against the
  // baseline `beginEdit` recorded, so Save is dead until there is something to
  // save. Raw `status` (not `composeStatus`) on purpose: the fallback resolves
  // once the status list lands, and reading it here would mark an untouched
  // form dirty on its own. Creating never gates — there is no baseline.
  const formDirty =
    pristineForm === null ||
    composeFingerprint({
      name: taskName,
      description,
      priority,
      status,
      assignedBy,
      assignee,
      assigneeId,
      reviewer,
      reviewerId,
      projectId,
      badgeKind,
      pendingAttachments: pendingAttachments.length,
    }) !== pristineForm;

  // The assignee pill shows the picked teammate's name + avatar when the
  // stored email matches an assignable user, else the raw stored value.
  const assigneeUser =
    assignableUsers.find(
      (u) => u.email.toLowerCase() === assignee.trim().toLowerCase()
    ) ?? null;
  const reviewerUser =
    assignableUsers.find(
      (u) => u.email.toLowerCase() === reviewer.trim().toLowerCase()
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

  // Dispatching a fix, showing its diff and driving Commit → Push → Create PR
  // all live in <AiFixPanel>, rendered inside the edit surface below.

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
    setReviewer("");
    setReviewerId(null);
    setProjectId(null);
    setBadgeKind("");
    clearSuggestions();
    setEditingId(null);
    setError("");
    setPendingAttachments([]);
    setExistingAttachments([]);
    setAssigneePickerOpen(false);
    setPristineForm(null);
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
    // The same values the setters below apply — recorded as the baseline Save
    // compares against, so an editor the user only looked at can't be saved.
    const loaded: ComposeFields = {
      name: task.name,
      description: task.description,
      priority: normalizePriority(task.priority),
      status: normalizeStatus(task.status, statusRows),
      assignedBy: task.assigned_by ?? "",
      assignee: task.assignee ?? "",
      assigneeId: task.assignee_id ?? null,
      reviewer: task.reviewer ?? "",
      reviewerId: task.reviewer_id ?? null,
      projectId: task.project_id ?? null,
      badgeKind: task.badge_kind ?? "",
      pendingAttachments: 0,
    };
    setPristineForm(composeFingerprint(loaded));
    setEditingId(task.id);
    setTaskName(loaded.name);
    setDescription(loaded.description);
    setPriority(loaded.priority);
    setStatus(loaded.status);
    setAssignedBy(loaded.assignedBy);
    setAssignee(loaded.assignee);
    setAssigneeId(loaded.assigneeId);
    setReviewer(loaded.reviewer);
    setReviewerId(loaded.reviewerId);
    setProjectId(loaded.projectId);
    setBadgeKind(loaded.badgeKind);
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

  // What opens an item from its row or card. Usually the name; on boards with
  // story keys it is the key badge, and the name is plain text. An item with
  // no key keeps the link on its name, so it can always be opened.
  const openTooltip = `Open ${config.labels.lowerSingular} details`;
  const keyOpens = (task: Task) =>
    !!config.features.storyKeys && taskKey(task) !== null;
  const keyOpenProps = (task: Task) =>
    keyOpens(task) ? { onOpen: () => openDetail(task), openTooltip } : {};
  const taskNameEl = (task: Task, className: string) =>
    keyOpens(task) ? (
      <span
        className={
          className.replace("task-card-title-link", "").trim() || undefined
        }
      >
        {task.name}
      </span>
    ) : (
      <button
        type="button"
        className={className}
        onClick={() => openDetail(task)}
        data-tooltip={openTooltip}
      >
        {task.name}
      </button>
    );

  // Clicking the Edit button: the full page when the board has one, else the
  // modal. Never the drawer — Edit is the "open the full editor" affordance.
  const openEditor = (task: Task) => {
    if (config.detailPath) {
      navigate(config.detailPath(task.id));
      return;
    }
    beginEdit(task, "modal");
  };

  // Boards with a detail page (stories, tickets) copy that page's full URL so
  // it can be shared anywhere. Plain tasks keep the `#42 Task name` snippet,
  // which chat links back to the Tasks board. copyText also works in the
  // desktop app, where Electron refuses navigator.clipboard.writeText.
  const copyTaskLink = (task: Task) => {
    const text = config.detailPath
      ? taskShareUrl(config.detailPath(task.id))
      : taskShareText(task);
    void copyText(text).then((ok) => {
      if (!ok) return;
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

  // An inline edit (status or type dropdown on a row) still goes through the
  // full-replace update endpoint, so every other field has to be echoed back or
  // the server would null it out — that is how a status flip used to silently
  // drop the assignee, project and type.
  const savePayloadFrom = (
    task: Task,
    overrides: Partial<SaveTaskPayload>
  ): SaveTaskPayload => ({
    name: task.name,
    description: task.description,
    priority: task.priority,
    status: task.status,
    assigned_by: task.assigned_by ?? "",
    assignee: task.assignee ?? "",
    assignee_id: task.assignee_id ?? null,
    project_id: task.project_id ?? null,
    ...(showType ? { badge_kind: task.badge_kind ?? null } : {}),
    ...(config.features.reviewer
      ? {
          reviewer: task.reviewer ?? "",
          reviewer_id: task.reviewer_id ?? null,
        }
      : {}),
    ...overrides,
  });

  // Writes one inline field change, flipping optimistically and rolling back on
  // failure: request-then-update lag is jarring when the user toggles a row's
  // dropdown repeatedly.
  const patchTask = async (
    task: Task,
    patch: Partial<Task> & Partial<SaveTaskPayload>,
    failure: string
  ) => {
    const prev = tasks;
    setTasks((current) =>
      sortTasks(current.map((t) => (t.id === task.id ? { ...t, ...patch } : t)))
    );
    try {
      const updated = await config.api.update(
        task.id,
        savePayloadFrom(task, patch)
      );
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
      window.alert(err instanceof Error ? err.message : failure);
    }
  };

  const changePriority = async (task: Task, next: TaskPriority) => {
    if (task.priority === next) return;
    await patchTask(task, { priority: next }, "Failed to update priority");
  };

  // Click-to-change priority, shown wherever a task's priority is (table row,
  // cards, board), like the status dropdown.
  const priorityPicker = (task: Task) => (
    <select
      className={`task-priority-select priority-${task.priority}`}
      value={task.priority}
      onChange={(event) =>
        void changePriority(task, normalizePriority(event.target.value))
      }
      aria-label={`Priority of ${task.name}`}
      data-tooltip={`Priority ${task.priority} — ${priorityLabel(task.priority)}`}
    >
      {PRIORITY_OPTIONS.map((value) => (
        <option key={value} value={value} title={priorityLabel(value)}>
          {`P${value}`}
        </option>
      ))}
    </select>
  );

  const changeStatus = async (task: Task, nextStatus: TaskStatus) => {
    if (task.status === nextStatus) return;
    await patchTask(task, { status: nextStatus }, "Failed to update status");
  };

  // Type is a Tickets-only field. For a ticket mirrored from a reported bug the
  // server keeps the support category authoritative, so the row snaps back to it
  // when the response lands.
  const changeType = async (task: Task, nextKind: string) => {
    if ((task.badge_kind ?? "") === nextKind) return;
    await patchTask(
      task,
      { badge_kind: nextKind || null },
      "Failed to update type"
    );
  };

  // Assign from the list: `email` is a member's address, or "" to unassign.
  const changePerson = async (
    task: Task,
    field: "assignee" | "reviewer",
    email: string
  ) => {
    if ((task[field] ?? "") === email) return;
    const member = assignableUsers.find((u) => u.email === email);
    const userId = member?.user_id ?? null;
    await patchTask(
      task,
      field === "assignee"
        ? { assignee: email, assignee_id: userId }
        : { reviewer: email, reviewer_id: userId },
      `Failed to update ${field}`
    );
  };

  const changeProject = async (task: Task, nextProject: number | null) => {
    if ((task.project_id ?? null) === nextProject) return;
    await patchTask(
      task,
      { project_id: nextProject },
      "Failed to update project"
    );
  };

  // The card badge key is the project name's first three letters plus the
  // per-user task number ("wayve" + 12 → "way12"), falling back to "#12" when
  // the task has no resolvable project. User stories use their own format.
  const taskKey = (task: Task): string | null => {
    if (task.task_number == null) return null;
    const name = projects.find((p) => p.id === task.project_id)?.name ?? "";
    if (config.features.storyKeys) return storyKey(task.task_number, name);
    const prefix = name
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 3)
      .toLowerCase();
    return prefix ? `${prefix}${task.task_number}` : `#${task.task_number}`;
  };

  const deleteTask = async (task: Task) => {
    const ok = window.confirm(
      `Delete ${config.labels.lowerSingular} "${task.name}"? This cannot be undone.`
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
          badge_kind: showType ? badgeKind || null : undefined,
          ...(config.features.reviewer
            ? { reviewer: reviewer.trim(), reviewer_id: reviewerId }
            : {}),
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
          badge_kind: showType ? badgeKind || null : undefined,
          ...(config.features.reviewer
            ? { reviewer: reviewer.trim(), reviewer_id: reviewerId }
            : {}),
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
  // A dragged column becomes a fixed px track; everything else keeps its
  // default. The title's default is flexible so it soaks up spare width, which
  // is why it is the one column that reads as truncated until you widen it.
  const col = (key: string, fallback: string) =>
    colWidths[key] ? `${colWidths[key]}px` : fallback;
  // Columns this board can show at all: Type and Related are ticket fields, and
  // the people columns are a team feature.
  const columnAvailable = (key: TableColumnKey): boolean => {
    switch (key) {
      case "type":
        return showType;
      case "related":
        return config.storageKey === "tickets";
      case "assignee":
      case "reporter":
        return showAssignee;
      case "reviewer":
        return showAssignee && !!config.features.reviewer;
      default:
        return true;
    }
  };
  const availableCols = TABLE_COLUMNS.filter((c) => columnAvailable(c.key));
  const visibleCols = availableCols.filter(
    (c) => c.locked || shownCols.includes(c.key)
  );
  const showKeyColumn = visibleCols.some((c) => c.key === "key");
  // No actions column: an item opens from its name, and Delete lives in the
  // editor it opens.
  // Boards with row checkboxes get a fixed leading track for them.
  const rowSelect = !!config.features.rowSelect;
  const selectTrack = rowSelect ? `${SELECT_COL_WIDTH} ` : "";
  const tableCols =
    selectTrack + visibleCols.map((c) => col(c.key, c.width)).join(" ");
  // The narrow-pane template: only the columns that keep a track there.
  const tableColsNarrow =
    selectTrack +
    visibleCols
      .filter((c) => c.narrow)
      .map((c) => c.narrow)
      .join(" ");
  const tableStyle = {
    "--task-cols": tableCols,
    "--task-cols-narrow": tableColsNarrow,
  } as React.CSSProperties;
  const wideOnly = (key: TableColumnKey) =>
    TABLE_COLUMNS.find((c) => c.key === key)?.narrow ? "" : " task-col--wide";
  const toggleColumn = (key: TableColumnKey) =>
    setShownCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  const pickableCols = availableCols.filter((c) => !c.locked);
  const colsMatching = pickableCols.filter((c) =>
    c.label.toLowerCase().includes(colsQuery.trim().toLowerCase())
  );
  const shownPickable = pickableCols.filter((c) =>
    shownCols.includes(c.key)
  ).length;

  // Until a grip is dragged the table keeps its original layout exactly: tracks
  // sized to the container, no horizontal scroll.
  const hasCustomCols = Object.keys(colWidths).length > 0;

  // Below this a column is unreadable, and a mis-drag could otherwise shrink one
  // to nothing with no obvious way back.
  const MIN_COL_PX = 56;

  // Drag a header's right-hand grip to resize that column. Width is measured
  // from the header cell at drag start and offset by the pointer delta, so the
  // column tracks the cursor exactly regardless of its starting track type
  // (px or fr). Listeners go on the window so the drag survives the pointer
  // leaving the 8px grip, and `setPointerCapture` keeps it alive over iframes.
  const startColResize = (
    event: React.PointerEvent<HTMLSpanElement>,
    key: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const grip = event.currentTarget;
    const cell = grip.parentElement;
    if (!cell) return;
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    grip.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-col-resizing");

    const onMove = (e: PointerEvent) => {
      const next = Math.max(
        MIN_COL_PX,
        Math.round(startWidth + (e.clientX - startX))
      );
      setColWidths((prev) => ({ ...prev, [key]: next }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-col-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Double-click a grip to hand the column back to its default width.
  const resetColWidth = (key: string) =>
    setColWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  // Wraps a header cell so it can carry a resize grip. The wrapper becomes the
  // grid child; the original cell keeps its own classes and styling.
  const headCell = (
    key: TableColumnKey,
    node: React.ReactNode,
    center = false
  ) => (
    <div
      key={key}
      className={`task-th-wrap${center ? " task-th-wrap--center" : ""}${wideOnly(key)}`}
    >
      {node}
      <span
        className="task-th-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${key} column`}
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => startColResize(e, key)}
        onDoubleClick={() => resetColWidth(key)}
      />
    </div>
  );

  // The team member behind a task's assignee email, for the Assignee column.
  // Falls back to the raw stored value (silhouette avatar) when it isn't a
  // known member, and null when unassigned.
  const personInfo = (
    rawEmail: string | null | undefined,
    knownId: number | null
  ): { name: string; userId: number | null } | null => {
    const email = (rawEmail ?? "").trim();
    if (!email) return null;
    const match = assignableUsers.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    return {
      name: match?.username || email,
      userId: match?.user_id ?? knownId,
    };
  };
  const assigneeInfo = (task: Task) =>
    personInfo(task.assignee, task.assignee_id ?? null);

  // Avatar + name for a person column, or a muted placeholder.
  const personCell = (
    who: { name: string; userId: number | null } | null,
    empty: string
  ) =>
    who ? (
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
      <span className="task-trow-muted">{empty}</span>
    );

  // The Assignee and Reviewer cells: the current person's avatar beside a
  // dropdown of every member who can be picked, so either changes from the
  // list like status and priority do. Someone set by a typed address who isn't
  // a member stays listed, so opening the menu never drops them. Without a
  // member list (it failed to load) the cell is read-only.
  const personPicker = (task: Task, field: "assignee" | "reviewer") => {
    const label = field === "assignee" ? "Assignee" : "Reviewer";
    const empty = field === "assignee" ? "Unassigned" : "No reviewer";
    const who =
      field === "assignee"
        ? assigneeInfo(task)
        : personInfo(task.reviewer, task.reviewer_id ?? null);
    if (assignableUsers.length === 0) return personCell(who, empty);
    const current = (task[field] ?? "").trim();
    const isMember = assignableUsers.some(
      (u) => u.email.toLowerCase() === current.toLowerCase()
    );
    return (
      <>
        {who && (
          <Avatar
            name={who.name}
            src={
              who.userId
                ? `${getApiBase()}/api/users/${who.userId}/avatar`
                : undefined
            }
            size={22}
          />
        )}
        <select
          className={`task-assignee-select${current ? "" : " is-unassigned"}`}
          value={
            isMember
              ? (assignableUsers.find(
                  (u) => u.email.toLowerCase() === current.toLowerCase()
                )?.email ?? current)
              : current
          }
          onChange={(event) =>
            void changePerson(task, field, event.target.value)
          }
          aria-label={`${label} of ${task.name}`}
          data-tooltip={`Change ${label.toLowerCase()}`}
        >
          <option value="">{empty}</option>
          {current && !isMember && <option value={current}>{current}</option>}
          {assignableUsers.map((u) => (
            <option key={u.user_id} value={u.email}>
              {u.username || u.email}
            </option>
          ))}
        </select>
      </>
    );
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
        case "updated":
          return new Date(t.updated_at ?? 0).getTime();
        case "priority":
          return t.priority;
        case "assignee":
          return (assigneeInfo(t)?.name ?? "").toLowerCase();
        case "reviewer":
          return (
            personInfo(t.reviewer, t.reviewer_id ?? null)?.name ?? ""
          ).toLowerCase();
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
  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return "↕";
    return sortDir === "asc" ? "↑" : "↓";
  };

  const sortHeader = (key: SortKey, label: string, extra = "") => (
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

  // The header cell for one column.
  const headFor = (key: TableColumnKey): React.ReactNode => {
    switch (key) {
      case "created":
        return headCell(
          key,
          sortHeader("created", "Created", "task-th--created")
        );
      case "updated":
        return headCell(key, sortHeader("updated", "Updated"));
      case "title":
        return headCell(
          key,
          <div className="task-th task-th--title">{config.labels.singular}</div>
        );
      case "assignee":
        return headCell(
          key,
          sortHeader("assignee", "Assignee", "task-th--assignee")
        );
      case "reviewer":
        return headCell(key, sortHeader("reviewer", "Reviewer"));
      case "priority":
        return headCell(
          key,
          sortHeader("priority", "Priority", "task-th--center"),
          true
        );
      case "status":
        return headCell(key, sortHeader("status", "Status"));
      default: {
        const label = TABLE_COLUMNS.find((c) => c.key === key)?.label ?? key;
        return headCell(
          key,
          <div className={`task-th task-th--${key}`}>{label}</div>
        );
      }
    }
  };

  // The table's column headers, reused above the active and completed rows.
  const toggleSelected = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // The header checkbox covers the rows of its own table (the open items or
  // the completed ones): ticked when all are, and a click ticks or clears them.
  const setRowsSelected = (rows: Task[], selected: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const t of rows) {
        if (selected) next.add(t.id);
        else next.delete(t.id);
      }
      return next;
    });
  // Counted against the loaded items, so a deleted one drops out by itself.
  const selectedCount = tasks.filter((t) => selectedIds.has(t.id)).length;

  const tableHead = (rows: Task[]) => {
    const picked = rows.filter((t) => selectedIds.has(t.id)).length;
    const all = rows.length > 0 && picked === rows.length;
    return (
      <div className="task-thead" role="row">
        {rowSelect && (
          <div className="task-tcell task-tcell--select" role="columnheader">
            <input
              type="checkbox"
              className="task-row-check"
              checked={all}
              ref={(el) => {
                if (el) el.indeterminate = picked > 0 && !all;
              }}
              disabled={rows.length === 0}
              onChange={() => setRowsSelected(rows, !all)}
              aria-label={`Select all ${config.labels.lowerPlural}`}
            />
          </div>
        )}
        {visibleCols.map((c) => headFor(c.key))}
      </div>
    );
  };

  // "Duplicate of way4" / "Similar to way4": the related ticket opens on click
  // when it's on this board, else the label shows its id.
  const relatedCell = (task: Task) => {
    if (task.related_to == null || !task.relation_kind) {
      return <span className="task-trow-muted">—</span>;
    }
    const target = tasks.find((t) => t.id === task.related_to);
    const verb =
      task.relation_kind === "duplicate" ? "Duplicate of" : "Similar to";
    const label = (target && taskKey(target)) || `#${task.related_to}`;
    return target ? (
      <button
        type="button"
        className={`task-related-pill task-related-pill--${task.relation_kind}`}
        onClick={() => openDetail(target)}
        data-tooltip={target.name}
      >
        {verb} {label}
      </button>
    ) : (
      <span
        className={`task-related-pill task-related-pill--${task.relation_kind}`}
      >
        {verb} {label}
      </span>
    );
  };

  // One body cell. `st` is the row's resolved status.
  const cellFor = (
    key: TableColumnKey,
    task: Task,
    st: ReturnType<typeof lookupStatus>
  ): React.ReactNode => {
    const cls = `task-tcell task-tcell--${key}${wideOnly(key)}`;
    switch (key) {
      case "created":
        return (
          <div key={key} className={cls}>
            {formatCreatedDate(task.created_at) || "—"}
          </div>
        );
      case "updated":
        return (
          <div key={key} className={cls}>
            {formatCreatedDate(task.updated_at) || "—"}
          </div>
        );
      case "key":
        return (
          <div key={key} className={cls}>
            <CopyLinkButton
              copied={copiedTaskId === task.id}
              onCopy={() => copyTaskLink(task)}
              label={task.name}
            />
            <TaskKeyBadge
              value={taskKey(task)}
              tooltip={config.labels.numberBadgeTooltip}
              {...keyOpenProps(task)}
            />
          </div>
        );
      case "title":
        return (
          <div key={key} className={cls}>
            {/* The copy-link icon leads the key: here, or in the Key column
                when that is shown. */}
            {!showKeyColumn && (
              <>
                <CopyLinkButton
                  copied={copiedTaskId === task.id}
                  onCopy={() => copyTaskLink(task)}
                  label={task.name}
                />
                <TaskKeyBadge
                  value={taskKey(task)}
                  tooltip={config.labels.numberBadgeTooltip}
                  {...keyOpenProps(task)}
                />
              </>
            )}
            {taskNameEl(task, "task-card-title-link task-trow-title")}
            {!showType && <TaskBadge kind={task.badge_kind} />}
            <JiraBadge task={task} />
            <GitlabBadge task={task} />
          </div>
        );
      case "type":
        return (
          <div key={key} className={cls}>
            <select
              className={`ticket-kind-select ticket-kind-${
                task.badge_kind ?? "unset"
              }`}
              value={task.badge_kind ?? ""}
              onChange={(event) => void changeType(task, event.target.value)}
              aria-label={`Type of ${task.name}`}
              data-tooltip="Ticket type"
            >
              <option value="">— Type</option>
              {TYPE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {BADGE_KINDS[value]?.label ?? value}
                </option>
              ))}
            </select>
          </div>
        );
      case "project":
        return (
          <div key={key} className={cls}>
            <select
              className="task-project-select"
              value={task.project_id ?? ""}
              onChange={(event) =>
                void changeProject(
                  task,
                  event.target.value ? Number(event.target.value) : null
                )
              }
              aria-label={`Project of ${task.name}`}
            >
              <option value="">— No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        );
      case "assignee":
        return (
          <div key={key} className={cls}>
            {personPicker(task, "assignee")}
          </div>
        );
      case "reviewer":
        return (
          <div key={key} className={`${cls} task-tcell--person`}>
            {personPicker(task, "reviewer")}
          </div>
        );
      case "reporter":
        return (
          <div key={key} className={`${cls} task-tcell--person`}>
            {personCell(personInfo(task.assigned_by, null), "—")}
          </div>
        );
      case "priority":
        return (
          <div key={key} className={cls}>
            {priorityPicker(task)}
          </div>
        );
      case "status":
        return (
          <div key={key} className={cls}>
            <TaskStatusIcon category={st.category} color={st.color} />
            <select
              className="task-status-select"
              style={statusSelectStyle(st)}
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
        );
      case "related":
        return (
          <div key={key} className={cls}>
            {relatedCell(task)}
          </div>
        );
      case "description": {
        const text = (task.description ?? "").trim();
        return (
          <div key={key} className={cls} title={text || undefined}>
            {text || <span className="task-trow-muted">—</span>}
          </div>
        );
      }
    }
  };

  // One table row. `completed` dims the row and strikes the title, mirroring the
  // completed-card treatment.
  const renderRow = (task: Task, completed: boolean) => {
    const st = lookupStatus(task.status);
    return (
      <div
        key={task.id}
        className={`task-trow${completed ? " task-trow--completed" : ""}${
          rowSelect && selectedIds.has(task.id) ? " task-trow--selected" : ""
        }`}
        role="row"
      >
        {rowSelect && (
          <div className="task-tcell task-tcell--select" role="cell">
            <input
              type="checkbox"
              className="task-row-check"
              checked={selectedIds.has(task.id)}
              onChange={() => toggleSelected(task.id)}
              aria-label={`Select ${task.name}`}
            />
          </div>
        )}
        {visibleCols.map((c) => cellFor(c.key, task, st))}
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
                            onClick={() => setStatusMenuOpen((open) => !open)}
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
                                "any" | "after" | "before" | "between"
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
                {mode === "tasks" && useTable && (
                  <div className="tasks-filters tasks-columns" ref={colsRef}>
                    <button
                      type="button"
                      className="tasks-status-filter tasks-filters-btn tasks-columns-btn"
                      onClick={() => setColsOpen((open) => !open)}
                      aria-haspopup="dialog"
                      aria-expanded={colsOpen}
                      aria-label="Choose columns"
                      data-tooltip="Choose columns"
                    >
                      <span aria-hidden="true">▥</span>
                      <span>Columns</span>
                    </button>
                    {colsOpen && (
                      <div
                        className="tasks-filters-popover tasks-columns-popover"
                        role="dialog"
                        aria-label="Columns"
                      >
                        <input
                          type="search"
                          className="tasks-columns-search"
                          placeholder="Search columns"
                          value={colsQuery}
                          onChange={(e) => setColsQuery(e.target.value)}
                          aria-label="Search columns"
                          autoFocus
                        />
                        <div className="tasks-columns-list">
                          {colsMatching.length === 0 ? (
                            <span className="tasks-columns-empty">
                              No matching columns
                            </span>
                          ) : (
                            colsMatching.map((c) => (
                              <label key={c.key} className="tasks-columns-item">
                                <input
                                  type="checkbox"
                                  checked={shownCols.includes(c.key)}
                                  onChange={() => toggleColumn(c.key)}
                                />
                                <span>{c.label}</span>
                              </label>
                            ))
                          )}
                        </div>
                        <div className="tasks-filters-footer">
                          <button
                            type="button"
                            className="tasks-filters-clear"
                            onClick={() => setShownCols(DEFAULT_SHOWN_COLUMNS)}
                          >
                            Reset to default
                          </button>
                          <span className="tasks-columns-count">
                            {shownPickable} of {pickableCols.length}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
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
          contained={inSplitPane}
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

              {/* Type is a Tickets-only field — the value shown in the board's
                  "Type" column (Bug/Feature/…). */}
              {showType && (
                <label className="task-pill" data-tooltip="Type">
                  <svg
                    className="task-pill-icon task-pill-icon--stroke"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path d="M2 3.5h7l4.5 4.5-6 6L2 9.5v-6z" />
                    <circle cx="5" cy="6" r="1" />
                  </svg>
                  <select
                    className="task-pill-select"
                    value={badgeKind}
                    aria-label="Type"
                    onChange={(event) => setBadgeKind(event.target.value)}
                  >
                    <option value="">No type</option>
                    {TYPE_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {BADGE_KINDS[value]?.label ?? value}
                      </option>
                    ))}
                  </select>
                </label>
              )}

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

              {/* Reviewer, on the boards that have one. A team feature like
                    assignment, so personal accounts don't see it. */}
              {!isPersonal && config.features.reviewer && (
                <div className="task-pill-wrap" ref={reviewerPickerRef}>
                  <button
                    type="button"
                    className="task-pill task-pill--button"
                    onClick={() => setReviewerPickerOpen((open) => !open)}
                    aria-expanded={reviewerPickerOpen}
                    aria-haspopup="dialog"
                    data-tooltip="Reviewer"
                  >
                    {reviewerUser ? (
                      <Avatar
                        name={reviewerUser.username || reviewerUser.email}
                        src={`${getApiBase()}/api/users/${reviewerUser.user_id}/avatar`}
                        size={16}
                      />
                    ) : (
                      <svg
                        className="task-pill-icon task-pill-icon--stroke"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                      >
                        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
                        <circle cx="8" cy="8" r="2" />
                      </svg>
                    )}
                    <span className="task-pill-text">
                      {reviewerUser?.username || reviewer.trim() || "Reviewer"}
                    </span>
                  </button>

                  {reviewerPickerOpen && (
                    <AssigneeMenu
                      role="reviewer"
                      users={assignableUsers}
                      selectedEmail={reviewer}
                      onClose={() => setReviewerPickerOpen(false)}
                      onSelect={(picked) => {
                        setReviewer(picked ? picked.email : "");
                        setReviewerId(picked ? picked.user_id : null);
                        setReviewerPickerOpen(false);
                      }}
                    />
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

            {/* Designs attach to a saved item, so this appears once the
                ticket or story exists — there is no id to hang them on
                before the first save. */}
            {config.features.figmaLinks && isEditing && editingId != null && (
              <div className="task-compose-designs">
                <span className="task-compose-designs-label">Design</span>
                <FigmaLinks
                  owner={
                    config.storageKey === "tickets"
                      ? { ticketId: editingId }
                      : { userStoryId: editingId }
                  }
                />
              </div>
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
                {/* Boards with a full page (stories, tickets) delete from
                    there; this form is the only place to delete a plain
                    task. */}
                {isEditing && editingTask && !config.detailPath && (
                  <button
                    type="button"
                    className="task-delete-btn"
                    onClick={() => void deleteTask(editingTask)}
                    disabled={submitting}
                  >
                    Delete
                  </button>
                )}
                <button
                  type="submit"
                  className="primary"
                  disabled={submitting || !formDirty}
                  title={formDirty ? undefined : "No changes to save"}
                >
                  {submitting
                    ? isEditing
                      ? "Saving…"
                      : "Creating…"
                    : isEditing
                      ? "Save changes"
                      : `Create ${config.labels.lowerSingular}`}
                </button>
              </div>
              {/* AI fix, inline: opening an item shows Claude's diff, the
                  editable file contents and Commit → Push → Create PR right
                  here, so a developer never has to navigate away to act on it. */}
              {isEditing && editingId !== null && config.api.aiFixPanel && (
                <AiFixPanel
                  itemId={editingId}
                  api={config.api.aiFixPanel}
                  canFix={priority >= (config.features.aiFixMinPriority ?? 1)}
                  minPriority={config.features.aiFixMinPriority ?? 1}
                  kind={config.labels.lowerSingular}
                  onChanged={() => void loadTasks()}
                />
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
                              {priorityPicker(task)}
                              <CopyLinkButton
                                copied={copiedTaskId === task.id}
                                onCopy={() => copyTaskLink(task)}
                                label={task.name}
                              />
                              <TaskKeyBadge
                                value={taskKey(task)}
                                tooltip={config.labels.numberBadgeTooltip}
                                {...keyOpenProps(task)}
                              />
                              <TaskBadge kind={task.badge_kind} />
                            </div>
                            {taskNameEl(
                              task,
                              "task-card-title-link task-board-card-title"
                            )}
                            <JiraBadge task={task} />
                            <GitlabBadge task={task} />
                            {formatCreatedAt(task.created_at) && (
                              <span className="task-card-created task-board-card-created">
                                Created {formatCreatedAt(task.created_at)}
                              </span>
                            )}
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
            {useTable && rowSelect && selectedCount > 0 && (
              <div className="task-selection-bar" role="status">
                <span>{selectedCount} selected</span>
                <button
                  type="button"
                  className="task-selection-clear"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </button>
              </div>
            )}
            {useTable ? (
              (listPlaceholder ?? (
                <div
                  className={`task-table${hasCustomCols ? " task-table--resized" : ""}${largeTextClass}`}
                  style={tableStyle}
                  role="table"
                >
                  {tableHead(activeTasks)}
                  {sortForTable(activeTasks).map((task) =>
                    renderRow(task, false)
                  )}
                </div>
              ))
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
                            <CopyLinkButton
                              copied={copiedTaskId === task.id}
                              onCopy={() => copyTaskLink(task)}
                              label={task.name}
                            />
                            <TaskKeyBadge
                              value={taskKey(task)}
                              tooltip={config.labels.numberBadgeTooltip}
                              {...keyOpenProps(task)}
                            />
                            <TaskBadge kind={task.badge_kind} />
                            <h3>
                              {taskNameEl(task, "task-card-title-link")}
                              <JiraBadge task={task} />
                              <GitlabBadge task={task} />
                            </h3>
                            {priorityPicker(task)}
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
                                style={statusSelectStyle(
                                  lookupStatus(task.status)
                                )}
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
                    className={`task-table${hasCustomCols ? " task-table--resized" : ""}${largeTextClass}`}
                    style={tableStyle}
                    role="table"
                  >
                    {tableHead(completedTasks)}
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
                            <CopyLinkButton
                              copied={copiedTaskId === task.id}
                              onCopy={() => copyTaskLink(task)}
                              label={task.name}
                            />
                            <TaskKeyBadge
                              value={taskKey(task)}
                              tooltip={config.labels.numberBadgeTooltip}
                              {...keyOpenProps(task)}
                            />
                            <TaskBadge kind={task.badge_kind} />
                            <h3>
                              {taskNameEl(task, "task-card-title-link")}
                              <JiraBadge task={task} />
                              <GitlabBadge task={task} />
                            </h3>
                            {priorityPicker(task)}
                          </div>
                          {formatCreatedAt(task.created_at) && (
                            <span className="task-card-created">
                              Created {formatCreatedAt(task.created_at)}
                            </span>
                          )}
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
