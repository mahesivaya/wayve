import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "./BrandLogo";
import { useAuth } from "../auth/useAuth";
import { canAccessApiKeyAdmin, hasPermission } from "../auth/permissions";
import { recordActivity } from "../api/activity";
import {
  Suspense,
  Fragment,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type DragEvent as ReactDragEvent,
} from "react";
import SearchProvider from "../search/SearchProvider";
import SearchBar from "../search/SearchBar";
import ProfileMenu from "./ProfileMenu";
import ReminderPopups from "./ReminderPopups";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";
import NotificationBell from "./NotificationBell";
import { SPLIT_APPS, type AppKey } from "./LayoutConfig";
import { useEmailsUnreadCount } from "../emails/useEmailsUnreadCount";
import { useChatUnreadCount } from "../chat/useChatUnreadCount";
import StorageLimitBanner from "./StorageLimitBanner";
import { SplitPaneContext } from "./SplitPaneContext";
import { SplitControlContext, type SplitTarget } from "./SplitControlContext";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "./useResizableWidth";
import { useIsNarrow } from "./useIsNarrow";
import PaneDropOverlay from "./PaneDropOverlay";
import SplitMenu from "./SplitMenu";
import {
  setPaneDragData,
  type DropZone,
  type PaneDragPayload,
  type PaneHalf,
} from "./paneDnd";
import { applyPaneDrop, type PaneArrangement } from "./paneLayout";
import { listTeams, createTeam, type Team } from "../api/workspace";
import { getFeatureAccess } from "../api/featureAccess";
import { isDesktopApp } from "../utils/desktop";
import "./Layout.css";
import {
  HomeIcon,
  EmailsIcon,
  ChatIcon,
  SchedulerIcon,
  DriveIcon,
  NotesIcon,
  TasksIcon,
  TestAccessIcon,
  AccessRequestsIcon,
  BillingIcon,
  DeveloperIcon,
  AnalyticsIcon,
  DomainsIcon,
  SecretsIcon,
  LogsIcon,
  UserLogsIcon,
  AuditIcon,
  TeamsIcon,
  DocsIcon,
  ApiRefIcon,
  LibrariesIcon,
  SdkIcon,
  ApiKeysIcon,
  GitLogoIcon,
  BugReportIcon,
  PlusIcon,
  CanvasIcon,
  FormsIcon,
  AutomationsIcon,
  WhiteboardIcon,
  InsightsIcon,
  AssistantIcon,
  WorkspaceIcon,
  PlatformIcon,
  DevelopersIcon,
  OrganizationIcon,
  MembersIcon,
} from "../icons";
import Modal from "./Modal";

function appKeyFromPath(pathname: string): AppKey {
  const match = SPLIT_APPS.find((app) => {
    if (app.key === "home") {
      return pathname === "/" || pathname === "/home";
    }
    return pathname === app.path;
  });

  return match?.key ?? "home";
}

// Several routes (/pricing, /support, /organization, …) render outside the
// Layout wrapper, so navigating to them unmounts Layout. Persisting the split
// keeps it intact on return.
const SPLIT_STORAGE_KEY = "rwayve.layout.split";

// Opt-in apps a personal account can add to its sidebar. Entries without a
// `path` are placeholders that route to the Coming Soon page.
const PERSONAL_APPS_STORAGE_KEY = "rwayve.layout.personalApps";
const ADDABLE_PERSONAL_APPS: {
  key: string;
  label: string;
  icon: ReactNode;
  path?: string;
}[] = [
  // Code Repo is a permanent sidebar item, so it is absent here by design.
  { key: "canvas", label: "Canvas", icon: <CanvasIcon size={22} /> },
  { key: "forms", label: "Forms", icon: <FormsIcon size={22} /> },
  {
    key: "automations",
    label: "Automations",
    icon: <AutomationsIcon size={22} />,
  },
  {
    key: "whiteboard",
    label: "Whiteboard",
    icon: <WhiteboardIcon size={22} />,
  },
  { key: "insights", label: "Insights", icon: <InsightsIcon size={22} /> },
  { key: "assistant", label: "Assistant", icon: <AssistantIcon size={22} /> },
];

// Display-only fallback when the org has no teams yet. Negative ids so they can
// never collide with a real backend row.
const SAMPLE_TEAMS: Team[] = [
  {
    id: -1,
    name: "Engineering",
    slug: "engineering",
    tagline: null,
    description: null,
  },
  { id: -2, name: "Design", slug: "design", tagline: null, description: null },
  {
    id: -3,
    name: "Operations",
    slug: "operations",
    tagline: null,
    description: null,
  },
];

function isValidAppKey(value: unknown): value is AppKey {
  return typeof value === "string" && SPLIT_APPS.some((a) => a.key === value);
}

// Which pane a sidebar click targets — the pane the user last clicked in.
type PaneFocus = "left" | "center" | "right";

const asPaneFocus = (v: unknown): PaneFocus =>
  v === "center" || v === "right" ? v : "left";

type PersistedSplit = {
  middleView: AppKey | null;
  rightView: AppKey | null;
  splitTarget: PaneFocus;
};

function loadPersistedSplit(): PersistedSplit {
  const empty: PersistedSplit = {
    middleView: null,
    rightView: null,
    splitTarget: "left",
  };
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return empty;
    }
    const obj = parsed as Record<string, unknown>;
    return {
      middleView: isValidAppKey(obj.middleView) ? obj.middleView : null,
      rightView: isValidAppKey(obj.rightView) ? obj.rightView : null,
      splitTarget: asPaneFocus(obj.splitTarget),
    };
  } catch {
    return empty;
  }
}

// Section expand state must live at module scope: `/docs*` pages mount their own
// <Layout> instance (DocsShell), so per-instance state would snap every section
// shut on navigation there. Not localStorage, so a full reload resets to these
// defaults: Workspace starts expanded, every other section collapsed. Collapsing
// a section still sticks for the rest of the session (until a full reload).
const persistedSidebarSections: Record<string, boolean> = { workspace: true };

// Simple sections supply `links`; interactive ones (Workspace, Teams) supply a
// custom `body`.
type SidebarLinkDef = {
  path: string;
  label: string;
  icon: ReactNode;
  visible?: boolean; // default true
  active?: boolean; // explicit active override (e.g. always-inactive links)
  activeWhen?: string; // pathname to match when `path` carries a query string
};
type SidebarSectionDef = {
  key: string; // expand-state key (also the React key)
  label: string;
  visible: boolean;
  icon?: ReactNode;
  collapsible?: boolean; // default true; false = plain label, always shown
  onAdd?: () => void;
  links?: SidebarLinkDef[];
  body?: ReactNode; // escape hatch for interactive sections
};

function useSidebarSections() {
  const [state, setState] = useState<Record<string, boolean>>(() => ({
    ...persistedSidebarSections,
  }));
  useEffect(() => {
    Object.assign(persistedSidebarSections, state);
  }, [state]);
  const isOpen = useCallback((key: string) => state[key] ?? false, [state]);
  const setOpen = useCallback(
    (key: string, open: boolean) => setState((s) => ({ ...s, [key]: open })),
    []
  );
  const toggle = useCallback(
    (key: string) => setState((s) => ({ ...s, [key]: !(s[key] ?? false) })),
    []
  );
  return { isOpen, setOpen, toggle };
}

export default function Layout({ children }: { children?: ReactNode } = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Gated on `user` so the badge fetches don't fire while the session is loading.
  const emailsUnreadCount = useEmailsUnreadCount(Boolean(user));
  const chatUnreadCount = useChatUnreadCount(Boolean(user));

  // Activity telemetry: a page view per route change and a click on every
  // button/link. Fire-and-forget; surfaced per-user on the User Audit page.
  const lastPathRef = useRef<string>("");
  useEffect(() => {
    if (!user) return;
    const path = location.pathname;
    if (path === lastPathRef.current) return;
    lastPathRef.current = path;
    recordActivity("page_view", { path });
  }, [user, location.pathname]);

  useEffect(() => {
    if (!user) return;
    let lastLabel = "";
    let lastAt = 0;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const el = target?.closest?.(
        "button, a, [role=button]"
      ) as HTMLElement | null;
      if (!el) return;
      const raw =
        el.getAttribute("aria-label") ||
        el.textContent?.trim() ||
        el.getAttribute("href") ||
        el.tagName;
      const label = (raw ?? "").toString().slice(0, 80);
      if (!label) return;
      const now = Date.now();
      // Throttle identical rapid clicks (e.g. double-clicks) to one row.
      if (label === lastLabel && now - lastAt < 500) return;
      lastLabel = label;
      lastAt = now;
      recordActivity("click", { label, path: window.location.pathname });
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [user]);

  const [middleView, setMiddleView] = useState<AppKey | null>(
    () => loadPersistedSplit().middleView
  );
  const [rightView, setRightView] = useState<AppKey | null>(
    () => loadPersistedSplit().rightView
  );

  // The pane the user last clicked in — a sidebar click retargets it (loads the
  // app into that pane only). `focusHalf` picks a sub-split half within it.
  const [splitTarget, setSplitTarget] = useState<PaneFocus>(
    () => loadPersistedSplit().splitTarget
  );
  const [focusHalf, setFocusHalf] = useState<"top" | "bottom">("top");

  // Focus a pane (and optionally one of its sub-split halves) in a single click.
  const focusPane = useCallback(
    (pane: PaneFocus, half: "top" | "bottom" = "top") => {
      setSplitTarget(pane);
      setFocusHalf(half);
    },
    []
  );

  // Non-null only while a pane drag is in flight. Gates the drop overlays, so
  // they exist exactly when a drop is possible and never intercept a click.
  const [paneDrag, setPaneDrag] = useState<PaneDragPayload | null>(null);

  // Starts a drag from a sidebar app link or a pane's title.
  const beginPaneDrag = useCallback(
    (e: ReactDragEvent, payload: PaneDragPayload) => {
      setPaneDragData(e.dataTransfer, payload);
      setPaneDrag(payload);
    },
    []
  );

  // One-shot focus hand-off for a programmatically-opened pane app (e.g. a chat
  // message's task link). Consumed by the pane on mount, so it is not persisted.
  const [paneTarget, setPaneTarget] = useState<SplitTarget | null>(null);

  const openApp = useCallback((app: AppKey, opts?: { taskId?: number }) => {
    setRightView(app);
    setSplitTarget("right");
    setFocusHalf("top");
    setPaneTarget({ app, taskId: opts?.taskId });
  }, []);

  const closeApp = useCallback(() => {
    setRightView(null);
    setSplitTarget("left");
    setFocusHalf("top");
    setPaneTarget(null);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SPLIT_STORAGE_KEY,
        JSON.stringify({ middleView, rightView, splitTarget })
      );
    } catch {
      // Storage quota / private mode — the split just won't persist.
    }
  }, [middleView, rightView, splitTarget]);

  // Personal accounts have no Workspace section, so extra apps are opt-in via a
  // "+" under the main nav. The chosen keys persist per-browser.
  const [personalApps, setPersonalApps] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PERSONAL_APPS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((k) => typeof k === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [addAppOpen, setAddAppOpen] = useState(false);

  const togglePersonalApp = useCallback((key: string) => {
    setPersonalApps((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      try {
        localStorage.setItem(PERSONAL_APPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage quota / private mode — non-fatal, just won't persist.
      }
      return next;
    });
  }, []);

  const [navOpen, setNavOpen] = useState(false);

  // At or below 768px the sidebar is an off-canvas overlay; above it, a
  // permanent rail. Shared with SettingsShell — see useIsNarrow.
  const isNarrow = useIsNarrow();

  const sections = useSidebarSections();
  // Team creation is org-owner-only. The control is hidden otherwise, but the
  // backend enforces it regardless.
  const [teams, setTeams] = useState<Team[]>([]);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamCreateDraft, setTeamCreateDraft] = useState("");
  const [billingAllowed, setBillingAllowed] = useState(true);

  const userId = user?.id;
  useEffect(() => {
    if (userId == null) return;
    let cancelled = false;
    listTeams()
      .then((rows) => !cancelled && setTeams(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const userScope = user?.scope;
  const userRole = user?.effective_role;
  useEffect(() => {
    // Only org and platform members have a feature-access matrix; personal
    // accounts keep the default (allowed).
    if (userScope !== "organization" && userScope !== "platform") return;
    let cancelled = false;
    void getFeatureAccess()
      .then((d) => {
        if (cancelled) return;
        const role = userRole ?? "";
        const bill = d.features.find((f) => f.key === "billing");
        setBillingAllowed(
          role === "owner" || !bill || bill.allowed_roles.includes(role)
        );
      })
      .catch(() => {
        if (!cancelled) {
          setBillingAllowed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userScope, userRole]);

  const submitNewTeam = () => {
    const name = teamCreateDraft.trim();
    setCreatingTeam(false);
    setTeamCreateDraft("");
    if (!name) return;
    createTeam({ name })
      .then((created) => setTeams((prev) => [created, ...prev]))
      .catch(() => {});
  };
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rwayve.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "rwayve.sidebar.collapsed",
        sidebarCollapsed ? "1" : "0"
      );
    } catch {
      // private mode / quota — preference just won't persist this session.
    }
  }, [sidebarCollapsed]);

  const sidebarRef = useRef<HTMLElement | null>(null);
  const { width: sidebarWidth, startResize: startSidebarResize } =
    useResizableWidth({
      storageKey: "rwayve.sidebar.width",
      defaultWidth: 200,
      min: 132,
      max: 360,
    });

  // Pane sizes are flex-grow ratios, so a new split lands at 50/50 (two panes)
  // or ~33% each (three).
  type PaneKey = "left" | "center" | "right";
  type PaneWeights = Record<PaneKey, number>;
  const PANE_WEIGHTS_STORAGE_KEY = "rwayve.layout.paneWeights";
  const PANE_MIN_WEIGHT = 0.15; // each pane keeps at least ~15% of its pair's share
  const [paneWeights, setPaneWeights] = useState<PaneWeights>(() => {
    try {
      const raw = localStorage.getItem(PANE_WEIGHTS_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const num = (v: unknown, fallback: number) =>
            typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
          return {
            left: num(obj.left, 1),
            center: num(obj.center, 1),
            right: num(obj.right, 1),
          };
        }
      }
    } catch {
      // ignore
    }
    return { left: 1, center: 1, right: 1 };
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        PANE_WEIGHTS_STORAGE_KEY,
        JSON.stringify(paneWeights)
      );
    } catch {
      // ignore
    }
  }, [paneWeights]);

  // Per-pane vertical sub-split: each top-level pane (left/center/right) can be
  // split once into two stacked halves that both show a duplicate of that pane's
  // app. Independent per pane — toggling one never affects another.
  const SUB_SPLIT_STORAGE_KEY = "rwayve.layout.subSplit";
  const [subSplit, setSubSplit] = useState<Record<PaneKey, boolean>>(() => {
    try {
      const raw = localStorage.getItem(SUB_SPLIT_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw) as Record<string, unknown>;
        return {
          left: o.left === true,
          center: o.center === true,
          right: o.right === true,
        };
      }
    } catch {
      // ignore
    }
    return { left: false, center: false, right: false };
  });
  useEffect(() => {
    try {
      localStorage.setItem(SUB_SPLIT_STORAGE_KEY, JSON.stringify(subSplit));
    } catch {
      // ignore
    }
  }, [subSplit]);
  // Top-half fraction within each sub-split pane (in-memory; resets on reload).
  const [subTop, setSubTop] = useState<Record<PaneKey, number>>({
    left: 0.5,
    center: 0.5,
    right: 0.5,
  });

  // Which app each pane's bottom (new) half shows. Defaults to Home; a sidebar
  // click while a bottom half is focused retargets it here.
  const SUB_BOTTOM_STORAGE_KEY = "rwayve.layout.subBottom";
  const [subBottomView, setSubBottomView] = useState<Record<PaneKey, AppKey>>(
    () => {
      try {
        const raw = localStorage.getItem(SUB_BOTTOM_STORAGE_KEY);
        if (raw) {
          const o = JSON.parse(raw) as Record<string, unknown>;
          const pick = (v: unknown): AppKey => (isValidAppKey(v) ? v : "home");
          return {
            left: pick(o.left),
            center: pick(o.center),
            right: pick(o.right),
          };
        }
      } catch {
        // ignore
      }
      return { left: "home", center: "home", right: "home" };
    }
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        SUB_BOTTOM_STORAGE_KEY,
        JSON.stringify(subBottomView)
      );
    } catch {
      // ignore
    }
  }, [subBottomView]);
  // The two split gestures, shared by the header split menu and the keyboard
  // shortcuts so there is one definition of what each does.

  // Horizontal: open the second column. Capped at two, and deliberately not a
  // toggle — silently closing a pane would discard whatever was in it; its ✕ is
  // the explicit way out. No-op once the second column exists.
  const splitHorizontally = useCallback(() => {
    setRightView((cur) => {
      if (cur !== null) return cur;
      focusPane("right");
      return "home";
    });
  }, [focusPane]);

  // Vertical: stack the focused pane into two halves. A toggle, matching the
  // pane toolbar's split button; a new half always starts on Home.
  const toggleVerticalSplit = useCallback(
    (pane: PaneFocus) => {
      setSubSplit((s) => {
        if (!s[pane]) setSubBottomView((v) => ({ ...v, [pane]: "home" }));
        return { ...s, [pane]: !s[pane] };
      });
      focusPane(pane, "top");
    },
    [focusPane]
  );

  // Keyboard equivalents of the drag gestures. Dragging is not keyboard
  // accessible, so without these there is no way to reach a split without a
  // mouse.
  //
  //   Cmd/Ctrl + \          horizontal split (open the second column)
  //   Cmd/Ctrl + Shift + \  vertical split (stack the focused pane)
  //
  // Mirrors VS Code, where \ is the split key.
  useEffect(() => {
    // Splits are hidden below 768px, so a shortcut there would only create
    // state the user can't see.
    if (isNarrow) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Never steal the key from a field the user is typing in.
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) toggleVerticalSplit(splitTarget);
      else splitHorizontally();
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isNarrow, splitTarget, splitHorizontally, toggleVerticalSplit]);

  // Resolves a drag-and-drop onto a pane. The rules live in `applyPaneDrop`
  // (pure and unit-tested); this only projects Layout's state into the shape it
  // expects and maps the result back onto the setters.
  const handlePaneDrop = useCallback(
    (
      target: PaneKey,
      targetHalf: PaneHalf,
      zone: DropZone,
      payload: PaneDragPayload
    ) => {
      setPaneDrag(null);
      const arrangement: PaneArrangement = {
        left: appKeyFromPath(location.pathname),
        center: middleView,
        right: rightView,
        subSplit,
        subBottomView,
      };
      const result = applyPaneDrop(
        arrangement,
        target,
        targetHalf,
        zone,
        payload
      );
      if (!result) return;

      setMiddleView(result.next.center);
      setRightView(result.next.right);
      setSubSplit(result.next.subSplit);
      setSubBottomView(result.next.subBottomView);
      // The left column is route-driven, so a change there is a navigation.
      if (result.navigateTo) {
        const path = SPLIT_APPS.find((a) => a.key === result.navigateTo)?.path;
        if (path) void navigate(path);
      }
      focusPane(result.focus.pane, result.focus.half);
    },
    [
      location.pathname,
      middleView,
      rightView,
      subSplit,
      subBottomView,
      navigate,
      focusPane,
    ]
  );

  // The layout is capped at two columns (see firstFreeColumn). Once the second
  // is open an edge drop can only replace, so the overlay stops previewing a
  // new column it cannot open.
  const columnsAvailable = rightView === null;

  const dropOverlay = (target: PaneKey, half: PaneHalf) =>
    paneDrag ? (
      <PaneDropOverlay
        canOpenNewColumn={columnsAvailable}
        // A pane already split into two halves can't split again.
        canSplitVertically={!subSplit[target]}
        onDrop={(zone, payload) => handlePaneDrop(target, half, zone, payload)}
      />
    ) : null;

  // Makes a pane's title behave like a VS Code tab: drag it to move the pane.
  const titleDragProps = (from: PaneKey, half: PaneHalf = "top") => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) =>
      beginPaneDrag(e, { kind: "pane", from, half }),
    onDragEnd: () => setPaneDrag(null),
  });

  const contentRef = useRef<HTMLDivElement>(null);

  // Resizes the boundary between two adjacent panes. Other panes' weights are
  // held fixed so dragging one boundary never shifts an untouched pane. The drag
  // listens on `document` so it survives leaving the handle's hitbox.
  const handlePaneResize = useCallback(
    (leftKey: PaneKey, rightKey: PaneKey) =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const container = contentRef.current;
        if (!container) return;
        const leftEl = container.querySelector<HTMLElement>(
          `.split-pane.${leftKey}`
        );
        const rightEl = container.querySelector<HTMLElement>(
          `.split-pane.${rightKey}`
        );
        if (!leftEl || !rightEl) return;

        const leftRect = leftEl.getBoundingClientRect();
        const rightRect = rightEl.getBoundingClientRect();
        const pairLeftEdge = leftRect.left;
        const pairWidth = rightRect.right - leftRect.left;
        const startLeftWeight = paneWeights[leftKey];
        const startRightWeight = paneWeights[rightKey];
        const pairWeight = startLeftWeight + startRightWeight;

        const onMove = (ev: PointerEvent) => {
          const rawFraction = (ev.clientX - pairLeftEdge) / pairWidth;
          const minFraction = PANE_MIN_WEIGHT;
          const maxFraction = 1 - PANE_MIN_WEIGHT;
          const fraction = Math.max(
            minFraction,
            Math.min(maxFraction, rawFraction)
          );
          setPaneWeights((w) => ({
            ...w,
            [leftKey]: pairWeight * fraction,
            [rightKey]: pairWeight * (1 - fraction),
          }));
        };

        const onUp = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
      },
    [paneWeights]
  );

  // Resizes a pane's internal top/bottom sub-split (Y axis, within one pane).
  // Stored as the top half's fraction of that pane's body height.
  const handleSubResize = useCallback(
    (key: PaneKey) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const bodyEl = contentRef.current?.querySelector<HTMLElement>(
        `.split-pane.${key} .split-pane-body--stacked`
      );
      if (!bodyEl) return;
      const rect = bodyEl.getBoundingClientRect();

      const onMove = (ev: PointerEvent) => {
        const frac = Math.max(
          PANE_MIN_WEIGHT,
          Math.min(1 - PANE_MIN_WEIGHT, (ev.clientY - rect.top) / rect.height)
        );
        setSubTop((t) => ({ ...t, [key]: frac }));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
    },
    []
  );

  const middleApp = SPLIT_APPS.find((a) => a.key === middleView) ?? null;
  const MiddleComp = middleApp?.Comp ?? null;
  const middleLabel = middleApp?.label ?? null;

  const rightApp = SPLIT_APPS.find((a) => a.key === rightView) ?? null;
  const RightComp = rightApp?.Comp ?? null;
  const rightLabel = rightApp?.label ?? null;
  const leftApp =
    SPLIT_APPS.find((a) => a.key === appKeyFromPath(location.pathname)) ?? null;
  const leftLabel = leftApp?.label ?? "Home";
  // A horizontal split (a second side-by-side pane) …
  const hasSecondPane = Boolean(middleView || rightView);
  // … or a lone left pane that's been vertically sub-split both count as "split
  // open": the left pane then renders its toolbar/halves instead of a plain page.
  const splitOpen = hasSecondPane || subSplit.left;

  // Open an app in whichever pane/half currently has focus, mirroring a sidebar
  // item's click. Controls that aren't sidebar <Link>s (e.g. the Reminders bell)
  // call this so they honor the focused pane instead of always routing the left
  // column. Falls back to navigation when no split is open or the left
  // (route-driven) pane is focused.
  const openInFocusedPane = useCallback(
    (app: AppKey) => {
      const path = SPLIT_APPS.find((a) => a.key === app)?.path ?? "/";
      if (!splitOpen) {
        void navigate(path);
        return;
      }
      if (focusHalf === "bottom" && subSplit[splitTarget]) {
        setSubBottomView((v) => ({ ...v, [splitTarget]: app }));
      } else if (splitTarget === "center") {
        setMiddleView(app);
      } else if (splitTarget === "right") {
        setRightView(app);
      } else {
        void navigate(path); // left = the route-driven column
      }
    },
    [splitOpen, focusHalf, subSplit, splitTarget, navigate]
  );

  const splitControl = useMemo(
    () => ({ openApp, target: paneTarget, closeApp, openInFocusedPane }),
    [openApp, paneTarget, closeApp, openInFocusedPane]
  );

  // Home fills any newly opened split pane (header split + sub-split's new half)
  // instead of duplicating the current app.
  const homeApp = SPLIT_APPS.find((a) => a.key === "home") ?? null;
  const HomeComp = homeApp?.Comp ?? null;
  const homeLabel = homeApp?.label ?? "Home";

  function closeLeftPane() {
    const fromKey: PaneKey = rightApp ? "right" : "center";
    const nextApp = rightApp ?? middleApp;
    if (!nextApp) return;
    void navigate(nextApp.path);
    // Promote the surviving pane — including its vertical sub-split (bottom app
    // + ratio) — into the left/main pane, so closing the left pane keeps that
    // pane exactly as it was.
    setSubSplit((s) => ({ ...s, left: s[fromKey], [fromKey]: false }));
    setSubBottomView((v) => ({ ...v, left: v[fromKey] }));
    setSubTop((t) => ({ ...t, left: t[fromKey] }));
    setRightView(null);
    if (fromKey === "center" || middleView === nextApp.key) {
      setMiddleView(null);
    }
    focusPane("left");
  }

  // Closes ONE half of a pane's sub-split, keeping the other as the full pane —
  // closing a half must never take its sibling with it. Closing the top half
  // promotes the bottom half's app to the pane's single view; closing the bottom
  // keeps the pane's current app (already the top).
  const closeHalf = (key: PaneKey, whichHalf: "top" | "bottom") => {
    if (whichHalf === "top") {
      const bottomKey = subBottomView[key];
      if (key === "left") {
        const path = SPLIT_APPS.find((a) => a.key === bottomKey)?.path ?? "/";
        void navigate(path);
      } else if (key === "center") {
        setMiddleView(bottomKey);
      } else {
        setRightView(bottomKey);
      }
    }
    setSubSplit((s) => ({ ...s, [key]: false }));
    focusPane(key, "top");
  };

  // Renders a pane's body. When the pane is sub-split it becomes two stacked
  // half-panes, each a mini-pane with its own toolbar (title + split toggle + ✕):
  // the top half keeps the pane's app; the new (bottom) half shows `subBottomView`
  // (Home by default). Clicking a half focuses it, so a sidebar click retargets
  // only that half. The ✕/toggle collapses the sub-split. When not split, the
  // single app fills the body (the pane's own toolbar sits above, separately).
  const renderPaneBody = (key: PaneKey, label: string, node: ReactNode) => {
    const bodyOf = (content: ReactNode) => (
      <div className="split-pane-body">
        <SplitPaneContext.Provider value={true}>
          <Suspense fallback={<div className="split-loading">Loading…</div>}>
            {content}
          </Suspense>
        </SplitPaneContext.Provider>
      </div>
    );
    if (!subSplit[key]) {
      return bodyOf(node);
    }
    const bottomApp =
      SPLIT_APPS.find((a) => a.key === subBottomView[key]) ?? homeApp;
    const BottomComp = bottomApp?.Comp ?? HomeComp;
    const bottomLabel = bottomApp?.label ?? homeLabel;

    const half = (
      whichHalf: "top" | "bottom",
      title: string,
      content: ReactNode,
      grow: number
    ) => {
      const focused = splitTarget === key && focusHalf === whichHalf;
      return (
        <div
          className={`pane-half ${focused ? "active-target" : ""}`.trim()}
          style={{ flexGrow: grow }}
          // Capture phase + focus: any interaction in the half re-targets it,
          // even children that stop propagation or take keyboard focus.
          onMouseDownCapture={() => focusPane(key, whichHalf)}
          onFocusCapture={() => focusPane(key, whichHalf)}
        >
          <div className="split-pane-toolbar">
            <span className="split-pane-title" {...titleDragProps(key, whichHalf)}>
              {title}
            </span>
            <div className="split-pane-tools">
              <button
                className="split-close-btn"
                onClick={() => closeHalf(key, whichHalf)}
                data-tooltip="Close this pane"
                aria-label="Close this pane"
              >
                ✕
              </button>
            </div>
          </div>
          {bodyOf(content)}
          {dropOverlay(key, whichHalf)}
        </div>
      );
    };
    return (
      <div className="split-pane-body split-pane-body--stacked">
        {half("top", label, node, subTop[key])}
        <div
          className="split-resize-handle split-resize-handle--horizontal"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize pane"
          onPointerDown={handleSubResize(key)}
        />
        {half(
          "bottom",
          bottomLabel,
          BottomComp ? <BottomComp /> : node,
          1 - subTop[key]
        )}
      </div>
    );
  };

  // With the split open, a sidebar click loads the app into whichever pane (and
  // sub-split half) the user last clicked — never the others. When closed, the
  // link navigates normally.
  const renderSidebarItem = useCallback(
    (
      path: string,
      app: AppKey,
      label: string,
      icon: ReactNode,
      badge?: number
    ) => {
      const isLeftActive =
        app === "home"
          ? location.pathname === "/" || location.pathname === "/home"
          : location.pathname === path;
      const isMiddleActive = middleView === app;
      const isRightActive = rightView === app;
      const showBadge = typeof badge === "number" && badge > 0;

      return (
        <Link
          key={app}
          to={path}
          title={label}
          className={`sidebar-link ${isLeftActive ? "active" : ""} ${isMiddleActive || isRightActive ? "active-split" : ""}`.trim()}
          // Drag any app onto a pane to open it exactly where you drop it. One
          // handler here covers every split app in the sidebar.
          draggable
          onDragStart={(e) => beginPaneDrag(e, { kind: "app", app })}
          onDragEnd={() => setPaneDrag(null)}
          onClick={(e) => {
            setNavOpen(false);
            if (!splitOpen) return; // no split — navigate normally
            // Route the click to the focused pane / half only.
            if (focusHalf === "bottom" && subSplit[splitTarget]) {
              e.preventDefault();
              setSubBottomView((v) => ({ ...v, [splitTarget]: app }));
            } else if (splitTarget === "center") {
              e.preventDefault();
              setMiddleView(app);
            } else if (splitTarget === "right") {
              e.preventDefault();
              setRightView(app);
            }
            // splitTarget === "left" (top): let the Link navigate, which changes
            // the routed left pane.
          }}
        >
          <span className="sidebar-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="sidebar-label">{label}</span>
          {showBadge && (
            <span className="sidebar-badge" aria-label={`${badge} unread`}>
              {badge}
            </span>
          )}
        </Link>
      );
    },
    [
      location.pathname,
      middleView,
      rightView,
      splitTarget,
      splitOpen,
      focusHalf,
      subSplit,
      beginPaneDrag,
    ]
  );

  const renderSidebarLink = (
    path: string,
    label: string,
    icon: ReactNode,
    isActive: boolean
  ) => (
    <Link
      to={path}
      title={label}
      className={`sidebar-link ${isActive ? "active" : ""}`.trim()}
      onClick={() => setNavOpen(false)}
    >
      <span className="sidebar-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sidebar-label">{label}</span>
    </Link>
  );

  // `onAdd`, when supplied, renders a "+" after the chevron so an org owner can
  // create a team inline.
  const renderSectionToggle = (
    label: string,
    expanded: boolean,
    onToggle: () => void,
    onAdd?: () => void,
    icon?: ReactNode
  ) => (
    <div className="sidebar-section-header">
      <button
        type="button"
        className="sidebar-section-label sidebar-section-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {icon && (
          <span className="sidebar-section-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span>{label}</span>
        <span
          className={`sidebar-section-chevron${expanded ? " open" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      {onAdd && (
        <button
          type="button"
          className="sidebar-section-add-btn"
          data-tooltip={`New ${label}`}
          aria-label={`New ${label}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAdd();
          }}
        >
          +
        </button>
      )}
    </div>
  );

  // All hooks must run before this guard — an earlier return would change the
  // hook call order between renders (React rules of hooks).
  if (!user) {
    return <div className="layout-loading">Loading session...</div>;
  }

  const authedUser = user;
  // A switchable owner only sees admin nav in admin mode. The downscoped /me
  // already flips scope/role/permissions in normal mode; ANDing this into the
  // section flags also prevents an admin-nav flash during optimistic (pre-/me)
  // login state.
  const adminMode = user.mode !== "normal" || !user.can_switch_admin;
  const canAccessPlatformBilling =
    user.scope === "platform" &&
    billingAllowed &&
    (hasPermission(user, "billing:read") ||
      hasPermission(user, "billing:manage"));
  const canAccessPlatformDeveloper =
    user.scope === "platform" &&
    (hasPermission(user, "logs:read") ||
      hasPermission(user, "logs:read_limited") ||
      hasPermission(user, "api_keys:manage"));
  const canAccessPlatformMembers =
    user.scope === "platform" && hasPermission(user, "members:read");
  const canAccessPlatformSupport =
    user.scope === "platform" && hasPermission(user, "members:read");
  const canAccessPlatformAnalytics =
    user.scope === "platform" && hasPermission(user, "members:read");
  // Domain administration is the platform owner's alone, not all platform staff
  // — mirrors the backend require_platform_owner gate.
  const isPlatformOwner =
    adminMode && user.scope === "platform" && user.effective_role === "owner";
  const isOrgOwner =
    adminMode &&
    user.scope === "organization" &&
    user.effective_role === "owner";
  // Custom-domain verification is a business / enterprise capability.
  const orgTier = user.current_plan?.tier;
  const canManageDomains =
    isOrgOwner && (orgTier === "business" || orgTier === "enterprise");
  const currentPlanCode = authedUser.current_plan?.code ?? "basic_user";
  const isBasicPersonalUser =
    authedUser.account_type === "personal" &&
    currentPlanCode === "basic_user" &&
    user.scope !== "platform" &&
    user.scope !== "organization";

  function goToUpgrade() {
    // Must target /billing, not /pricing: RedirectIfPersonal bounces personal
    // users off /pricing, and this nudge only renders for personal users.
    const params = new URLSearchParams({
      account: authedUser.account_type,
      plan: currentPlanCode,
    });
    void navigate(`/billing?${params.toString()}`, {
      state: {
        accountType: authedUser.account_type,
        currentPlan: authedUser.current_plan,
        userId: authedUser.id,
        email: authedUser.email,
      },
    });
  }

  const hasPlatformSection =
    adminMode &&
    (canAccessPlatformBilling ||
      canAccessPlatformDeveloper ||
      canAccessPlatformSupport ||
      canAccessPlatformAnalytics ||
      isPlatformOwner);

  // Every org and platform member sees Workspace; personal accounts have none.
  // Backend RBAC still gates the individual pages.
  const hasWorkspaceSection =
    user.scope === "platform" || user.scope === "organization";

  const renderLinks = (links?: SidebarLinkDef[]) =>
    links
      ?.filter((l) => l.visible !== false)
      .map((l) => (
        <Fragment key={`${l.path}|${l.label}`}>
          {renderSidebarLink(
            l.path,
            l.label,
            l.icon,
            l.active ?? location.pathname === (l.activeWhen ?? l.path)
          )}
        </Fragment>
      ));

  // Non-collapsible groups (Organization) show a plain label with links directly
  // underneath, deliberately without the `.sidebar-subitems` wrapper.
  const renderSection = (s: SidebarSectionDef) => {
    if (!s.visible) return null;
    if (s.collapsible === false) {
      return (
        <div className="sidebar-section" key={s.key}>
          <div className="sidebar-section-label">
            {s.icon && (
              <span className="sidebar-section-icon" aria-hidden="true">
                {s.icon}
              </span>
            )}
            <span>{s.label}</span>
          </div>
          {renderLinks(s.links)}
        </div>
      );
    }
    const open = sections.isOpen(s.key);
    return (
      <div className="sidebar-section" key={s.key}>
        {renderSectionToggle(
          s.label,
          sections.isOpen(s.key),
          () => sections.toggle(s.key),
          s.onAdd,
          s.icon
        )}
        {open &&
          (s.body ?? (
            <div className="sidebar-subitems">{renderLinks(s.links)}</div>
          ))}
      </div>
    );
  };

  const displayTeams = teams.length ? teams : SAMPLE_TEAMS;

  const sectionDefs: SidebarSectionDef[] = [
    {
      key: "workspace",
      label: "Workspace",
      visible: hasWorkspaceSection,
      icon: <WorkspaceIcon size={16} />,
      body: (
        <div className="sidebar-subitems">
          <Link
            to="/documents"
            title="Library"
            className={`sidebar-project-label${
              location.pathname === "/documents" ? " active" : ""
            }`}
            onClick={() => setNavOpen(false)}
          >
            📄 Library
          </Link>
          <Link
            to="/projects"
            title="Projects"
            className={`sidebar-project-label${
              location.pathname === "/projects" ? " active" : ""
            }`}
            onClick={() => setNavOpen(false)}
          >
            🗂 Projects
          </Link>
          {user.effective_role !== "guest" && (
            <Link
              to="/github"
              title="Code Repo"
              className={`sidebar-project-label${
                location.pathname === "/github" ? " active" : ""
              }`}
              onClick={(e) => {
                setNavOpen(false);
                if (!splitOpen) return;
                if (focusHalf === "bottom" && subSplit[splitTarget]) {
                  e.preventDefault();
                  setSubBottomView((v) => ({ ...v, [splitTarget]: "github" }));
                } else if (splitTarget === "center") {
                  e.preventDefault();
                  setMiddleView("github");
                } else if (splitTarget === "right") {
                  e.preventDefault();
                  setRightView("github");
                }
              }}
            >
              <GitLogoIcon size={14} /> Code Repo
            </Link>
          )}
        </div>
      ),
    },
    {
      key: "teams",
      label: "Teams",
      icon: <TeamsIcon size={16} />,
      // Teams are org-scoped, so the section would always be empty for personal
      // accounts.
      visible: user.account_type !== "personal",
      onAdd:
        (isOrgOwner || isPlatformOwner) && !sidebarCollapsed
          ? () => {
              sections.setOpen("teams", true);
              setTeamCreateDraft("");
              setCreatingTeam(true);
            }
          : undefined,
      body: (
        <div className="sidebar-subitems">
          {creatingTeam && (
            <input
              className="sidebar-project-edit"
              value={teamCreateDraft}
              autoFocus
              placeholder="New team…"
              aria-label="New team name"
              onChange={(e) => setTeamCreateDraft(e.target.value)}
              onBlur={submitNewTeam}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewTeam();
                else if (e.key === "Escape") {
                  setCreatingTeam(false);
                  setTeamCreateDraft("");
                }
              }}
            />
          )}
          {displayTeams.map((team) => (
            <Fragment key={team.slug}>
              {renderSidebarLink(
                `/teams/${team.slug}`,
                team.name,
                <TeamsIcon size={16} />,
                location.pathname === `/teams/${team.slug}`
              )}
            </Fragment>
          ))}
          {!creatingTeam && displayTeams.length === 0 && (
            <div className="sidebar-empty-hint">No teams yet</div>
          )}
        </div>
      ),
    },
    {
      key: "platform",
      label: "Platform",
      visible: hasPlatformSection,
      icon: <PlatformIcon size={16} />,
      links: [
        {
          path: "/platform/members",
          label: "Members & roles",
          icon: <MembersIcon size={16} />,
          visible: canAccessPlatformMembers,
        },
        {
          path: "/platform/billing",
          label: "Billing",
          icon: <BillingIcon size={16} />,
          visible: canAccessPlatformBilling,
        },
        {
          path: "/platform/developer",
          label: "Developer",
          icon: <DeveloperIcon size={16} />,
          visible: canAccessPlatformDeveloper,
        },
        {
          path: "/platform/support",
          label: "Support",
          icon: <BugReportIcon className="sidebar-bug-icon" />,
          visible: canAccessPlatformSupport,
        },
        {
          path: "/platform/analytics",
          label: "Analytics",
          icon: <AnalyticsIcon size={16} />,
          visible: canAccessPlatformAnalytics,
        },
        {
          path: "/coming-soon",
          label: "Domains",
          icon: <DomainsIcon size={16} />,
          visible: isPlatformOwner,
        },
        {
          path: "/platform/secrets",
          label: "Secrets",
          icon: <SecretsIcon size={16} />,
          visible: isPlatformOwner,
        },
        {
          path: "/platform/access",
          label: "Feature Access",
          icon: <ApiKeysIcon size={16} />,
          visible: isPlatformOwner,
        },
      ],
    },
    {
      key: "developers",
      label: "Developers",
      visible: user.account_type !== "personal",
      icon: <DevelopersIcon size={16} />,
      links: [
        {
          path: "/docs",
          label: "Docs",
          icon: <DocsIcon size={16} />,
          visible: user.scope === "platform",
        },
        {
          path: "/docs/api",
          label: "API reference",
          icon: <ApiRefIcon size={16} />,
        },
        // Libraries and SDK share a route; only SDK is ever marked active.
        {
          path: "/docs/developers",
          label: "Libraries",
          icon: <LibrariesIcon size={16} />,
          active: false,
        },
        { path: "/docs/developers", label: "SDK", icon: <SdkIcon size={16} /> },
        {
          path: "/api-keys",
          label: "API Keys",
          icon: <ApiKeysIcon size={16} />,
          visible: canAccessApiKeyAdmin(user),
        },
      ],
    },
    {
      key: "organization",
      label: "Organization",
      visible: isOrgOwner,
      icon: <OrganizationIcon size={16} />,
      collapsible: false,
      links: [
        {
          path: "/organization/domains",
          label: "Domains",
          icon: <DomainsIcon size={16} />,
          activeWhen: "/organization/domains",
          visible: canManageDomains,
        },
        { path: "/logs/app", label: "App Logs", icon: <LogsIcon size={16} /> },
        {
          path: "/logs/audit",
          label: "Audit Logs",
          icon: <AuditIcon size={16} />,
        },
        {
          path: "/logs/user-audit",
          label: "User Audit",
          icon: <UserLogsIcon size={16} />,
        },
        {
          path: "/organization/access",
          label: "Feature Access",
          icon: <ApiKeysIcon size={16} />,
        },
      ],
    },
  ];

  // The profile control lives at the bottom of the sidebar in both runtimes
  // (desktop as a plain Settings button, web as the full ProfileMenu dropdown).
  // `headerActions` is the cluster that stays in the header in both.
  const desktop = isDesktopApp();

  // The settings-family pages render their own left rail (SettingsShell), so
  // the main sidebar steps aside there and the rail's Back button returns home.
  // Both runtimes behave the same; only narrow screens keep the normal sidebar,
  // since a 240px rail beside the content doesn't fit a phone.
  //
  // Only routes that actually render SettingsShell may appear here — hiding the
  // sidebar on a page without the rail would leave no way back.
  const settingsTakeover =
    !isNarrow &&
    [
      "/settings",
      "/profile",
      "/integrations",
      "/appearance",
      "/settings/statuses",
    ].includes(location.pathname);

  const headerActions = (
    <>
      {/* The desktop shell surfaces Upgrade on the Settings page instead. */}
      {!desktop && isBasicPersonalUser && (
        <button
          type="button"
          className="header-upgrade-btn"
          onClick={goToUpgrade}
        >
          Upgrade
        </button>
      )}

      {/* Elevated-session indicator, pinned in the top-right just before the
          split control while a switchable owner is in admin mode. */}
      {user.mode === "admin" && user.can_switch_admin && (
        <span className="admin-mode-badge" title="You are in admin mode">
          🛡️ Admin mode
        </span>
      )}

      {/* One split control in the top-right; the menu offers only the splits
          that can still be made. Hidden below 768px, where splits are too. */}
      {!isNarrow && (
        <SplitMenu
          canSplitHorizontal={rightView === null}
          canSplitVertical={!subSplit[splitTarget]}
          onSplitHorizontal={splitHorizontally}
          onSplitVertical={() => toggleVerticalSplit(splitTarget)}
        />
      )}
    </>
  );

  return (
    <SplitControlContext.Provider value={splitControl}>
      <div className="app">
        <ReminderPopups />
        <SearchProvider>
          <div className="header">
            <div
              className={`header-brand${
                sidebarCollapsed && !isNarrow ? " collapsed" : ""
              }`}
              style={
                !isNarrow && !sidebarCollapsed
                  ? { width: `${sidebarWidth}px` }
                  : undefined
              }
            >
              <div className="logo" onClick={() => navigate("/")}>
                {/* The wordmark hides when the sidebar collapses to the icon rail.
                The narrow overlay has no collapsed rail, so it always shows. */}
                <BrandLogo className="logo-mark" size={desktop ? 24 : 26} />
                {!(sidebarCollapsed && !isNarrow) && (
                  <span className="logo-word">{BRAND_NAME}</span>
                )}
              </div>
              {/* Desktop expand/collapse toggle, docked next to the brand mark so
              it stays reachable whether the sidebar is a full panel or an icon
              rail. The narrow overlay uses the hamburger below instead; hidden
              while settings takes over (there's no sidebar to toggle). */}
              {!isNarrow && !settingsTakeover && (
                <button
                  type="button"
                  className="sidebar-collapse-btn header-collapse-btn"
                  onClick={() => setSidebarCollapsed((c) => !c)}
                  data-tooltip={
                    sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
                  }
                  aria-label={
                    sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
                  }
                  aria-expanded={!sidebarCollapsed}
                >
                  <svg
                    className="sidebar-collapse-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    {/* The arrow points the way the panel will move on click. */}
                    <rect x="3" y="5" width="18" height="14" rx="2.2" />
                    <line x1="9" y1="5" x2="9" y2="19" />
                    {sidebarCollapsed ? (
                      <polyline points="12 9 15 12 12 15" />
                    ) : (
                      <polyline points="15 9 12 12 15 15" />
                    )}
                  </svg>
                </button>
              )}
              {/* This toggle is the mobile hamburger only. On wide screens the
              show/hide control lives next to the brand above; the overlay has no
              persistent divider to host it, so it needs the header button. */}
              {isNarrow && !settingsTakeover && (
                <button
                  type="button"
                  className="sidebar-toggle-btn"
                  onClick={() => setNavOpen((open) => !open)}
                  data-tooltip={navOpen ? "Hide sidebar" : "Show sidebar"}
                  aria-label={navOpen ? "Hide sidebar" : "Show sidebar"}
                  aria-expanded={navOpen}
                >
                  <svg
                    className="sidebar-toggle-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="3" y="5" width="18" height="14" rx="2.2" />
                    <line x1="9" y1="5" x2="9" y2="19" />
                    {/* The arrow points the way the panel will move on click. */}
                    {navOpen ? (
                      <polyline points="15 9 12 12 15 15" />
                    ) : (
                      <polyline points="12 9 15 12 12 15" />
                    )}
                  </svg>
                </button>
              )}
            </div>

            {/* Emails and Notes own their own in-page search, so the header
            search is suppressed there to avoid two competing search inputs.
            Chat has no in-page search box — the header search drives it. */}
            {!location.pathname.startsWith("/emails") &&
              !location.pathname.startsWith("/notes") && <SearchBar />}

            <div className="actions">{headerActions}</div>
          </div>

          <StorageLimitBanner onUpgrade={goToUpgrade} />

          <div className="body">
            <nav
              ref={sidebarRef}
              className={`sidebar ${navOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""} ${settingsTakeover ? "takeover-hidden" : ""}`.trim()}
              style={
                !sidebarCollapsed && !isNarrow
                  ? { width: `${sidebarWidth}px` }
                  : undefined
              }
              aria-label="Primary navigation"
            >
              <div className="sidebar-section">
                {renderSidebarItem("/", "home", "Home", <HomeIcon size={18} />)}
                <NotificationBell variant="sidebar" />
                {renderSidebarItem(
                  "/emails",
                  "emails",
                  "Inbox",
                  <EmailsIcon size={18} />,
                  emailsUnreadCount
                )}
                {renderSidebarItem(
                  "/chat",
                  "chat",
                  "Messages",
                  <ChatIcon size={18} />,
                  chatUnreadCount
                )}
                {/* /call is intentionally absent — audio/video lives inside Chat. */}
                {renderSidebarItem(
                  "/scheduler",
                  "scheduler",
                  "Scheduler",
                  <SchedulerIcon size={18} />
                )}
                {renderSidebarItem(
                  "/drive",
                  "drive",
                  "Drive",
                  <DriveIcon size={18} />
                )}
                {renderSidebarItem(
                  "/notes",
                  "notes",
                  "Notes",
                  <NotesIcon size={18} />
                )}
                {renderSidebarItem(
                  "/tasks",
                  "tasks",
                  "Tasks",
                  <TasksIcon size={18} />
                )}
                {/* Code Repo is personal-only here; workspace users get it inside
                the Workspace section, so listing it for both would duplicate. */}
                {user.account_type === "personal" &&
                  renderSidebarItem(
                    "/github",
                    "github",
                    "Code Repo",
                    <GitLogoIcon size={18} />
                  )}
                {user.account_type === "personal" && (
                  <>
                    {ADDABLE_PERSONAL_APPS.filter((a) =>
                      personalApps.includes(a.key)
                    ).map((a) =>
                      a.path ? (
                        renderSidebarItem(
                          a.path,
                          a.key as AppKey,
                          a.label,
                          a.icon
                        )
                      ) : (
                        // Placeholder app: no real route yet, so it lands on the
                        // shared Coming Soon page carrying its label.
                        <button
                          key={a.key}
                          type="button"
                          className="sidebar-link sidebar-link-placeholder"
                          data-tooltip={`${a.label} (coming soon)`}
                          onClick={() =>
                            navigate(
                              `/coming-soon?feature=${encodeURIComponent(a.label)}`
                            )
                          }
                        >
                          <span className="sidebar-icon" aria-hidden="true">
                            {a.icon}
                          </span>
                          <span className="sidebar-label">{a.label}</span>
                        </button>
                      )
                    )}
                    {ADDABLE_PERSONAL_APPS.some(
                      (a) => !personalApps.includes(a.key)
                    ) && (
                      <button
                        type="button"
                        className="sidebar-link sidebar-add-app-btn"
                        data-tooltip="Add app"
                        onClick={() => setAddAppOpen(true)}
                      >
                        <span className="sidebar-icon" aria-hidden="true">
                          <PlusIcon size={18} />
                        </span>
                        <span className="sidebar-label">Add</span>
                      </button>
                    )}
                  </>
                )}
                {(user.scope === "platform" || user.scope === "organization") &&
                  renderSidebarItem(
                    "/test-access",
                    "test_access",
                    "Test Access",
                    <TestAccessIcon size={18} />
                  )}
                {(isOrgOwner || isPlatformOwner) &&
                  renderSidebarLink(
                    "/access-requests",
                    "Access Requests",
                    <AccessRequestsIcon size={16} />,
                    location.pathname === "/access-requests"
                  )}
              </div>

              {sectionDefs.map(renderSection)}

              <div className="sidebar-spacer" />

              {/* Sits below the flex spacer so it stays pinned to the bottom
              regardless of how many nav groups render above it. */}
              {/* Desktop shell: a plain profile button pinned to the bottom that
              opens Settings (that runtime has no dropdown). */}
              {desktop && (
                <div className="sidebar-section sidebar-section-bottom">
                  <button
                    type="button"
                    className={`sidebar-link sidebar-profile-btn${
                      location.pathname === "/settings" ? " active" : ""
                    }`}
                    data-tooltip={`${user.email} — open settings`}
                    onClick={() => {
                      setNavOpen(false);
                      void navigate("/settings");
                    }}
                  >
                    <span className="sidebar-icon" aria-hidden="true">
                      <Avatar
                        name={user.email}
                        src={`${getApiBase()}/api/users/${user.id}/avatar`}
                        size={22}
                      />
                    </span>
                    <span className="sidebar-label">{user.email}</span>
                  </button>
                </div>
              )}

              {/* Web build: the profile menu lives at the sidebar bottom (like
              the desktop button), but keeps its full dropdown — Log out,
              Appearance, admin switch — rather than just linking to Settings. */}
              {!desktop && (
                <div className="sidebar-section sidebar-section-bottom">
                  <ProfileMenu placement="sidebar" />
                </div>
              )}
            </nav>

            {/* Resizing is meaningless in the icon rail, the narrow overlay,
              or when settings takes over and the sidebar is hidden. */}
            {!sidebarCollapsed && !isNarrow && !settingsTakeover && (
              <ResizeHandle
                onPointerDown={startSidebarResize}
                ariaLabel="Resize sidebar"
              />
            )}

            {/* Scrim catches taps outside the sidebar overlay on narrow screens. */}
            {navOpen && (
              <div
                className="sidebar-scrim"
                onClick={() => setNavOpen(false)}
                aria-hidden="true"
              />
            )}

            <div className={`content`} ref={contentRef}>
              <div
                className={`split-pane left ${splitOpen && splitTarget === "left" && !subSplit.left ? "active-target" : ""}`}
                // Capture phase + focus so ANY interaction inside the pane
                // (a child that stops mousedown propagation, or a keyboard
                // focus) re-targets it — not just a bare click on the div.
                // When sub-split, the half's own handler owns focus; don't
                // let the pane div override it back to the top half.
                onMouseDownCapture={() => {
                  if (!subSplit.left) focusPane("left");
                }}
                onFocusCapture={() => {
                  if (!subSplit.left) focusPane("left");
                }}
                style={splitOpen ? { flexGrow: paneWeights.left } : undefined}
              >
                {splitOpen ? (
                  <>
                    {!subSplit.left && (
                      <div className="split-pane-toolbar">
                        <span
                          className="split-pane-title"
                          {...titleDragProps("left")}
                        >
                          {leftLabel}
                        </span>
                        <div className="split-pane-tools">
                          <button
                            className="split-close-btn"
                            onClick={closeLeftPane}
                            data-tooltip="Close pane"
                            aria-label="Close left pane"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                    {renderPaneBody("left", leftLabel, children ?? <Outlet />)}
                    {!subSplit.left && dropOverlay("left", "top")}
                  </>
                ) : (
                  <>
                    <Suspense
                      fallback={<div className="split-loading">Loading…</div>}
                    >
                      {children ?? <Outlet />}
                    </Suspense>
                    {/* No split open yet: dropping here is how the first one
                        gets created, so the whole page is a drop target. */}
                    {dropOverlay("left", "top")}
                  </>
                )}
              </div>

              {hasSecondPane && (
                <div
                  className="split-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize pane"
                  onPointerDown={handlePaneResize(
                    "left",
                    middleView ? "center" : "right"
                  )}
                />
              )}

              {middleView && (
                <div
                  className={`split-pane center ${splitTarget === "center" && !subSplit.center ? "active-target" : ""}`}
                  onMouseDownCapture={() => {
                    if (!subSplit.center) focusPane("center");
                  }}
                  onFocusCapture={() => {
                    if (!subSplit.center) focusPane("center");
                  }}
                  style={{ flexGrow: paneWeights.center }}
                >
                  {!subSplit.center && (
                    <div className="split-pane-toolbar">
                      <span
                        className="split-pane-title"
                        {...titleDragProps("center")}
                      >
                        {middleLabel}
                      </span>
                      <div className="split-pane-tools">
                        <button
                          className="split-close-btn"
                          onClick={() => {
                            setMiddleView(null);
                            setSubSplit((s) => ({ ...s, center: false }));
                          }}
                          data-tooltip="Close pane"
                          aria-label="Close center pane"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                  {MiddleComp &&
                    renderPaneBody("center", middleLabel ?? "", <MiddleComp />)}
                  {!subSplit.center && dropOverlay("center", "top")}
                </div>
              )}

              {/* Second handle only exists when all three panes are visible. */}
              {middleView && rightView && (
                <div
                  className="split-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize pane"
                  onPointerDown={handlePaneResize("center", "right")}
                />
              )}

              {rightView && (
                <div
                  className={`split-pane right ${splitTarget === "right" && !subSplit.right ? "active-target" : ""}`}
                  onMouseDownCapture={() => {
                    if (!subSplit.right) focusPane("right");
                  }}
                  onFocusCapture={() => {
                    if (!subSplit.right) focusPane("right");
                  }}
                  style={{ flexGrow: paneWeights.right }}
                >
                  {!subSplit.right && (
                    <div className="split-pane-toolbar">
                      <span
                        className="split-pane-title"
                        {...titleDragProps("right")}
                      >
                        {rightLabel}
                      </span>
                      <div className="split-pane-tools">
                        <button
                          className="split-close-btn"
                          onClick={() => {
                            setRightView(null);
                            setSplitTarget("left");
                            setPaneTarget(null);
                            setSubSplit((s) => ({ ...s, right: false }));
                          }}
                          data-tooltip="Close pane"
                          aria-label="Close right pane"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}
                  {RightComp &&
                    renderPaneBody("right", rightLabel ?? "", <RightComp />)}
                  {!subSplit.right && dropOverlay("right", "top")}
                </div>
              )}
            </div>
          </div>
        </SearchProvider>

        <Modal
          isOpen={addAppOpen}
          onClose={() => setAddAppOpen(false)}
          title="Add to sidebar"
        >
          <div className="add-app-grid">
            {ADDABLE_PERSONAL_APPS.map((a) => {
              const checked = personalApps.includes(a.key);
              return (
                <button
                  key={a.key}
                  type="button"
                  className={`add-app-card${checked ? " checked" : ""}`}
                  aria-pressed={checked}
                  onClick={() => togglePersonalApp(a.key)}
                >
                  <span className="add-app-checkbox" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                  <span className="add-app-icon" aria-hidden="true">
                    {a.icon}
                  </span>
                  <span className="add-app-label">{a.label}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      </div>
    </SplitControlContext.Provider>
  );
}
