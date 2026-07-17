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
} from "react";
import SearchProvider from "../search/SearchProvider";
import SearchBar from "../search/SearchBar";
import ProfileMenu from "./ProfileMenu";
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

type PersistedSplit = {
  middleView: AppKey | null;
  rightView: AppKey | null;
  splitTarget: "left" | "right";
};

function loadPersistedSplit(): PersistedSplit {
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    if (!raw) return { middleView: null, rightView: null, splitTarget: "left" };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { middleView: null, rightView: null, splitTarget: "left" };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      middleView: isValidAppKey(obj.middleView) ? obj.middleView : null,
      rightView: isValidAppKey(obj.rightView) ? obj.rightView : null,
      splitTarget: obj.splitTarget === "right" ? "right" : "left",
    };
  } catch {
    return { middleView: null, rightView: null, splitTarget: "left" };
  }
}

// Section expand state must live at module scope: `/docs*` pages mount their own
// <Layout> instance (DocsShell), so per-instance state would snap every section
// shut on navigation there. Not localStorage, so a full reload still starts
// collapsed.
const persistedSidebarSections: Record<string, boolean> = {};

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

  // Decides whether the next nav-link click navigates or retargets the pane.
  const [splitTarget, setSplitTarget] = useState<"left" | "right">(
    () => loadPersistedSplit().splitTarget
  );

  // One-shot focus hand-off for a programmatically-opened pane app (e.g. a chat
  // message's task link). Consumed by the pane on mount, so it is not persisted.
  const [paneTarget, setPaneTarget] = useState<SplitTarget | null>(null);

  const openApp = useCallback((app: AppKey, opts?: { taskId?: number }) => {
    setRightView(app);
    setSplitTarget("right");
    setPaneTarget({ app, taskId: opts?.taskId });
  }, []);

  const closeApp = useCallback(() => {
    setRightView(null);
    setSplitTarget("left");
    setPaneTarget(null);
  }, []);

  const splitControl = useMemo(
    () => ({ openApp, target: paneTarget, closeApp }),
    [openApp, paneTarget, closeApp]
  );

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
  // permanent rail.
  const [isNarrow, setIsNarrow] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 768px)").matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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

  const middleApp = SPLIT_APPS.find((a) => a.key === middleView) ?? null;
  const MiddleComp = middleApp?.Comp ?? null;
  const middleLabel = middleApp?.label ?? null;

  const rightApp = SPLIT_APPS.find((a) => a.key === rightView) ?? null;
  const RightComp = rightApp?.Comp ?? null;
  const rightLabel = rightApp?.label ?? null;
  const leftApp =
    SPLIT_APPS.find((a) => a.key === appKeyFromPath(location.pathname)) ?? null;
  const leftLabel = leftApp?.label ?? "Home";
  const splitOpen = Boolean(middleView || rightView);

  function duplicateCurrentApp() {
    setRightView(appKeyFromPath(location.pathname));
    setSplitTarget("right");
  }

  function closeLeftPane() {
    const nextApp = rightApp ?? middleApp;
    if (!nextApp) return;
    void navigate(nextApp.path);
    setRightView(null);
    if (middleView === nextApp.key) {
      setMiddleView(null);
    }
    setSplitTarget("left");
  }

  // With the split open, sidebar clicks retarget the right pane instead of
  // navigating; when closed the link behaves normally.
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
          onClick={(e) => {
            setNavOpen(false);
            if (splitTarget === "right") {
              e.preventDefault();
              setRightView(app);
            }
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
    [location.pathname, middleView, rightView, splitTarget]
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
          title={`New ${label}`}
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
                if (splitTarget === "right") {
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

  // Desktop shell: the settings-family pages render their own left rail
  // (SettingsShell), so the main sidebar steps aside there and the rail's
  // Back button returns home. Web keeps the normal sidebar.
  const settingsTakeover =
    desktop &&
    ["/settings", "/profile", "/integrations", "/appearance"].includes(
      location.pathname
    );

  const headerActions = (
    <>
      {user.mode === "admin" && user.can_switch_admin && (
        <span className="admin-mode-badge" title="You are in admin mode">
          🛡️ Admin mode
        </span>
      )}
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

      <button
        type="button"
        className={`duplicate-pane-btn ${splitTarget === "right" ? "active" : ""}`}
        onClick={duplicateCurrentApp}
        title="Duplicate current app"
        aria-label="Duplicate current app"
      >
        <svg
          className="duplicate-pane-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <line x1="12" y1="5" x2="12" y2="19" />
        </svg>
      </button>
    </>
  );

  return (
    <SplitControlContext.Provider value={splitControl}>
      <div className="app">
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
                  title={
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
                  title={navOpen ? "Hide sidebar" : "Show sidebar"}
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
                <NotificationBell
                  variant="sidebar"
                  emailUnread={emailsUnreadCount}
                  chatUnread={chatUnreadCount}
                />
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
                          title={`${a.label} (coming soon)`}
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
                        title="Add app"
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
                    title={`${user.email} — open settings`}
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
                className={`split-pane left ${splitOpen && splitTarget === "left" ? "active-target" : ""}`}
                onMouseDown={() => setSplitTarget("left")}
                style={splitOpen ? { flexGrow: paneWeights.left } : undefined}
              >
                {splitOpen ? (
                  <>
                    <div className="split-pane-toolbar">
                      <span className="split-pane-title">{leftLabel}</span>
                      <button
                        className="split-close-btn"
                        onClick={closeLeftPane}
                        title="Close pane"
                        aria-label="Close left pane"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="split-pane-body">
                      <SplitPaneContext.Provider value={true}>
                        <Suspense
                          fallback={
                            <div className="split-loading">Loading…</div>
                          }
                        >
                          {children ?? <Outlet />}
                        </Suspense>
                      </SplitPaneContext.Provider>
                    </div>
                  </>
                ) : (
                  <Suspense
                    fallback={<div className="split-loading">Loading…</div>}
                  >
                    {children ?? <Outlet />}
                  </Suspense>
                )}
              </div>

              {splitOpen && (
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
                  className="split-pane center"
                  style={{ flexGrow: paneWeights.center }}
                >
                  <div className="split-pane-toolbar">
                    <span className="split-pane-title">{middleLabel}</span>
                    <button
                      className="split-close-btn"
                      onClick={() => setMiddleView(null)}
                      title="Close pane"
                      aria-label="Close center pane"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="split-pane-body">
                    {MiddleComp && (
                      <SplitPaneContext.Provider value={true}>
                        <Suspense
                          fallback={
                            <div className="split-loading">Loading…</div>
                          }
                        >
                          <MiddleComp />
                        </Suspense>
                      </SplitPaneContext.Provider>
                    )}
                  </div>
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
                  className={`split-pane right ${splitTarget === "right" ? "active-target" : ""}`}
                  onMouseDown={() => setSplitTarget("right")}
                  style={{ flexGrow: paneWeights.right }}
                >
                  <div className="split-pane-toolbar">
                    <span className="split-pane-title">{rightLabel}</span>
                    <button
                      className="split-close-btn"
                      onClick={() => {
                        setRightView(null);
                        setSplitTarget("left");
                        setPaneTarget(null);
                      }}
                      title="Close pane"
                      aria-label="Close right pane"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="split-pane-body">
                    {RightComp && (
                      <SplitPaneContext.Provider value={true}>
                        <Suspense
                          fallback={
                            <div className="split-loading">Loading…</div>
                          }
                        >
                          <RightComp />
                        </Suspense>
                      </SplitPaneContext.Provider>
                    )}
                  </div>
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
