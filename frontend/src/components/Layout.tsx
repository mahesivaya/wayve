import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "./BrandLogo";
import { useAuth } from "../auth/useAuth";
import {
  canAccessApiKeyAdmin,
  canViewPricing,
  hasPermission,
} from "../auth/permissions";
import {
  Suspense,
  Fragment,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import SearchProvider from "../search/SearchProvider";
import SearchBar from "../search/SearchBar";
import ProfileMenu from "./ProfileMenu";
import SupportModal from "../support/SupportModal";
import { SPLIT_APPS, type AppKey } from "./LayoutConfig";
import { useEmailsUnreadCount } from "../emails/useEmailsUnreadCount";
import StorageLimitBanner from "./StorageLimitBanner";
import { SplitPaneContext } from "./SplitPaneContext";
import ResizeHandle from "./ResizeHandle";
import { useResizableWidth } from "./useResizableWidth";
import {
  listProjects,
  createProject,
  updateProject,
  listTeams,
  createTeam,
  type Project,
  type Team,
} from "../api/workspace";
import "./Layout.css";

// Shared bug-report glyph — amber warning triangle with a dark `!`.
// Used in both the header shortcut button (.header-bug-btn) and the
// Platform → Support sidebar entry so the two surfaces stay visually
// consistent. The colors are hard-coded (not currentColor) because the
// icon is intentionally two-tone.
function BugReportIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M11.13 3.3a1 1 0 0 1 1.74 0l9.4 16.3a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5z"
        fill="#f5a623"
      />
      <rect
        x="10.85"
        y="8.5"
        width="2.3"
        height="7.2"
        rx="1.05"
        fill="#2d2d2d"
      />
      <circle cx="12" cy="18.4" r="1.35" fill="#2d2d2d" />
    </svg>
  );
}

function appKeyFromPath(pathname: string): AppKey {
  const match = SPLIT_APPS.find((app) => {
    if (app.key === "home") {
      return pathname === "/" || pathname === "/home";
    }
    return pathname === app.path;
  });

  return match?.key ?? "home";
}

// `children` is optional. When omitted (the default usage via
// `<Route element={<Layout />}>`), the matched child route renders through
// `<Outlet />`. When provided, callers can wrap arbitrary content in the
// same chrome — used by the Pricing page which lives outside the routing
// tree's ProtectedRoute branch but still wants the standard header/sidebar
// for signed-in visitors.
// Persist the split layout across Layout unmounts. Some routes
// (/pricing, /enterprise, /support, /services/:slug, /organization,
// /forgot-password, /reset-password, /recover-with-mnemonic) live
// OUTSIDE the Layout wrapper in App.tsx — visiting them unmounts the
// whole Layout component, which would otherwise reset the split to
// closed. Round-tripping through localStorage keeps the split intact
// when the user returns to a Layout-wrapped route.
const SPLIT_STORAGE_KEY = "rwayve.layout.split";

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

// Sidebar section expand/collapse persisted at MODULE scope. `/docs*` pages
// render their own <Layout> (DocsShell's OuterShell), a different React
// instance from the app's layout-route Layout — so navigating to a Developers
// link (→ /docs) would otherwise mount a fresh Layout with every section
// collapsed, snapping shut the group the user just clicked from. Persisting
// here keeps sections open across that instance swap and ordinary navigation.
// Module-level (not localStorage) so a full page reload still starts collapsed,
// matching the intended default.
const persistedSidebarSections: Record<string, boolean> = {};

// A single declarative model for the collapsible sidebar groups, so the six
// near-identical `<div className="sidebar-section">…</div>` blocks collapse
// into one render loop. Simple sections supply `links`; interactive ones
// (Workspace, Teams) supply a custom `body`.
type SidebarLinkDef = {
  path: string; // navigation target (the <Link to=>)
  label: string;
  icon: ReactNode;
  visible?: boolean; // default true
  active?: boolean; // explicit active override (e.g. always-inactive links)
  activeWhen?: string; // pathname to match for active (defaults to `path`);
  // used when `path` carries a query string the pathname won't equal.
};
type SidebarSectionDef = {
  key: string; // expand-state key (also the React key)
  label: string;
  visible: boolean;
  collapsible?: boolean; // default true; false = plain label, always shown
  onAdd?: () => void;
  links?: SidebarLinkDef[];
  body?: ReactNode; // escape hatch for interactive sections
};

// One keyed store for every collapsible sidebar group, replacing what used to
// be a separate useState per section. Seeded from (and synced back to) the
// module-level record above, so open sections survive the Layout instance swap
// and reset on a full reload.
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
  // Live unread badge for the Emails nav item. Fed by /api/emails/unread-count
  // (idx_emails_unread partial index) — index-only scan even on huge inboxes.
  // Gated on `user` so it doesn't fire while the session is still loading.
  const emailsUnreadCount = useEmailsUnreadCount(Boolean(user));

  // Three-pane state management. Lazy init reads any persisted split
  // from a previous visit; the effect below mirrors changes back.
  const [middleView, setMiddleView] = useState<AppKey | null>(
    () => loadPersistedSplit().middleView
  );
  const [rightView, setRightView] = useState<AppKey | null>(
    () => loadPersistedSplit().rightView
  );

  // Decides whether the next header-link click navigates or changes the duplicate pane.
  const [splitTarget, setSplitTarget] = useState<"left" | "right">(
    () => loadPersistedSplit().splitTarget
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        SPLIT_STORAGE_KEY,
        JSON.stringify({ middleView, rightView, splitTarget })
      );
    } catch {
      // Storage quota / private mode — silently ignore, split just
      // won't persist across reloads for this session.
    }
  }, [middleView, rightView, splitTarget]);

  // On narrow viewports the header nav collapses behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);

  // Track whether we're in the ≤768px "overlay" band (sidebar is an
  // off-canvas panel) vs. wider screens (permanent rail). Kept reactive so
  // the toggle button's arrow direction always reflects the real state.
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

  // "Report a bug" overlay — opened from the red header icon, also reachable
  // from the profile menu's "Help & Report issue" item.
  const [supportOpen, setSupportOpen] = useState(false);
  // Collapsible sidebar groups. Each starts open when the user is already on a
  // route inside it (so the active item is visible); otherwise collapsed.
  // Collapsible sidebar groups always start collapsed on mount/reload — they
  // no longer auto-expand from the current URL. The user opens what they want.
  // One keyed store for every collapsible group (logs/workspace/projects/
  // teams/platform/developers). `sections.isOpen(key)` / `.toggle(key)` /
  // `.setOpen(key, bool)`.
  const sections = useSidebarSections();
  // Projects + teams are org-scoped and fetched from the backend. Creation and
  // rename are org-owner-only (the controls are hidden otherwise; the backend
  // enforces it regardless).
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // id of the project currently being renamed (null = none) + its draft text.
  const [editingProject, setEditingProject] = useState<number | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  // Inline "new project" / "new team" rows (opened by the section "+" button).
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectCreateDraft, setProjectCreateDraft] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamCreateDraft, setTeamCreateDraft] = useState("");

  const userId = user?.id;
  useEffect(() => {
    if (userId == null) return;
    let cancelled = false;
    listProjects()
      .then((rows) => !cancelled && setProjects(rows))
      .catch(() => {});
    listTeams()
      .then((rows) => !cancelled && setTeams(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const commitProjectName = (id: number) => {
    const next = projectDraft.trim();
    setEditingProject(null);
    const current = projects.find((p) => p.id === id);
    if (!next || !current || next === current.name) return;
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name: next } : p))
    );
    updateProject(id, next).catch(() => {
      // Revert on failure so the sidebar reflects the persisted name.
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name: current.name } : p))
      );
    });
  };

  const submitNewProject = () => {
    const name = projectCreateDraft.trim();
    setCreatingProject(false);
    setProjectCreateDraft("");
    if (!name) return;
    createProject(name)
      .then((created) => setProjects((prev) => [created, ...prev]))
      .catch(() => {});
  };

  const submitNewTeam = () => {
    const name = teamCreateDraft.trim();
    setCreatingTeam(false);
    setTeamCreateDraft("");
    if (!name) return;
    createTeam({ name })
      .then((created) => setTeams((prev) => [created, ...prev]))
      .catch(() => {});
  };
  // Desktop sidebar can be collapsed to an icon-only rail. Persisted so the
  // user's preference survives reloads.
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

  // Drag-resizable nav sidebar width (when expanded, on non-overlay screens).
  const sidebarRef = useRef<HTMLElement | null>(null);
  const { width: sidebarWidth, startResize: startSidebarResize } =
    useResizableWidth({
      storageKey: "rwayve.sidebar.width",
      defaultWidth: 156,
      min: 132,
      max: 360,
    });

  // Split-pane weights — proportional sizes (flex-grow values) for the
  // left/center/right panes. Stored as numbers because flex-grow is just a
  // ratio; each pane gets `flex-grow: weight` and they share the content
  // area in proportion. Default 1 each so an opening split lands at 50/50
  // (two panes) or ~33% each (three panes). The user drags the handle
  // between two panes to adjust their relative weights — the others stay
  // unchanged so the unaffected pane doesn't jump while you're resizing.
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

  // Returns a pointerdown handler that resizes the boundary between two
  // adjacent panes. Other panes' weights are held fixed so dragging one
  // boundary never shifts an untouched pane. Drag captures pointer events
  // on `document` so the gesture survives leaving the handle's hitbox.
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

  // When the split is open, sidebar clicks target the right pane instead
  // of navigating the URL. When closed, the link behaves normally.
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

  // Clickable header for a collapsible sidebar group (Workspace, Platform,
  // Logs, Developers). Renders the label + a chevron that rotates with state.
  // `onAdd`, when supplied, renders a "+" button right after the chevron — used
  // to let an org owner create a new project / team from the section header.
  const renderSectionToggle = (
    label: string,
    expanded: boolean,
    onToggle: () => void,
    onAdd?: () => void
  ) => (
    <div className="sidebar-section-header">
      <button
        type="button"
        className="sidebar-section-label sidebar-section-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
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
  // Security/audit surface is platform-team-only. Even a non-platform user
  // with a stray `audit:read` permission stays hidden from the nav — the
  // page is for staff operating the platform, not customers of it.
  // Audit views (Audit Logs + User Logs) are restricted to the platform
  // OWNER only — not super_admin / security or any other audit:read holder.
  // Mirrors the backend require_owner gate on the audit endpoints.
  const canAccessSecurity =
    user.scope === "platform" && user.effective_role === "owner";
  // Platform-wide billing console: aggregates revenue, customer subscriptions
  // and payroll across the whole platform. Distinct from the per-tenant
  // [/billing](../billing/Billing.tsx) self-service view; staff-only.
  const canAccessPlatformBilling =
    user.scope === "platform" &&
    (hasPermission(user, "billing:read") ||
      hasPermission(user, "billing:manage"));
  const canAccessPlatformDeveloper =
    user.scope === "platform" &&
    (hasPermission(user, "logs:read") ||
      hasPermission(user, "logs:read_limited") ||
      hasPermission(user, "api_keys:manage"));
  const canAccessPlatformSupport =
    user.scope === "platform" && hasPermission(user, "members:read");
  const canAccessPlatformAnalytics =
    user.scope === "platform" && hasPermission(user, "members:read");
  // Domain administration is restricted to the platform OWNER specifically
  // (not all platform staff) — mirrors the backend require_platform_owner gate.
  const isPlatformOwner =
    user.scope === "platform" && user.effective_role === "owner";
  // Organization owners get a Domains shortcut to their own org's custom-domain
  // administration. (Nav only — backend domain endpoints stay platform-owner
  // gated for now, so the link targets their org via ?org=<id>.)
  const isOrgOwner =
    user.scope === "organization" && user.effective_role === "owner";
  // Developers (org or platform scope) get the Code shortcut alongside owners.
  const isDeveloper = user.effective_role === "developer";
  // Pricing is hidden from roles that don't manage plans/billing (org +
  // platform scope) — only owner / super_admin / billing keep it. Shared with
  // the /pricing route guard so the URL can't bypass the hidden nav link.
  const canSeePricing = canViewPricing(user);
  const canAccessPlatformLogs =
    user.scope === "platform" &&
    (hasPermission(user, "logs:read") ||
      hasPermission(user, "logs:read_limited"));
  const currentPlanCode = authedUser.current_plan?.code ?? "basic_user";
  const isBasicPersonalUser =
    authedUser.account_type === "personal" &&
    currentPlanCode === "basic_user" &&
    user.scope !== "platform" &&
    user.scope !== "organization";

  function goToUpgrade() {
    // The Upgrade nudge is rendered only for `isBasicPersonalUser`, so we
    // always land on /billing — the page that actually lists the plan grid
    // (with Subscribe/Switch CTAs) plus the "Create organization" surface
    // for personal users who want team-tier plans. /pricing redirects
    // personal users to /settings via RedirectIfPersonal, so it would be a
    // dead end here.
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
    canAccessPlatformBilling ||
    canAccessPlatformDeveloper ||
    canAccessPlatformSupport ||
    canAccessPlatformAnalytics ||
    isPlatformOwner;

  // Logs get their own sidebar group, split out from Platform.
  const hasLogsSection =
    canAccessSecurity || canAccessPlatformLogs || isPlatformOwner;

  // Code lives in its own "Workspace" group. Same gate as the link itself so
  // the section header never renders empty. Visible to platform staff, any
  // developer, and organization owner / super_admin / admin.
  const isOrgManager =
    user.scope === "organization" &&
    ["owner", "super_admin", "admin"].includes(user.effective_role ?? "");
  const hasWorkspaceSection =
    user.scope === "platform" || isOrgManager || isDeveloper;

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

  // Renders one collapsible group from the registry. Non-collapsible groups
  // (Organization) show a plain label with links directly underneath (no
  // `.sidebar-subitems` wrapper, matching the prior markup). Collapsible groups
  // render the toggle, then — when open or in the icon rail — the custom `body`
  // or the mapped `links`.
  const renderSection = (s: SidebarSectionDef) => {
    if (!s.visible) return null;
    if (s.collapsible === false) {
      return (
        <div className="sidebar-section" key={s.key}>
          <div className="sidebar-section-label">{s.label}</div>
          {renderLinks(s.links)}
        </div>
      );
    }
    const open = sections.isOpen(s.key) || sidebarCollapsed;
    return (
      <div className="sidebar-section" key={s.key}>
        {renderSectionToggle(
          s.label,
          sections.isOpen(s.key),
          () => sections.toggle(s.key),
          s.onAdd
        )}
        {open &&
          (s.body ?? (
            <div className="sidebar-subitems">{renderLinks(s.links)}</div>
          ))}
      </div>
    );
  };

  const sectionDefs: SidebarSectionDef[] = [
    {
      key: "workspace",
      label: "Workspace",
      visible: hasWorkspaceSection,
      body: (
        <div className="sidebar-subitems">
          {/* Compact sub-item style (matches the project rows) so it
              doesn't tower over its Workspace neighbors. */}
          <Link
            to="/documents"
            title="Documents"
            className={`sidebar-project-label${
              location.pathname === "/documents" ? " active" : ""
            }`}
            onClick={() => setNavOpen(false)}
          >
            📄 Documents
          </Link>
          {renderSectionToggle(
            "Projects",
            sections.isOpen("projects"),
            () => sections.toggle("projects"),
            isOrgOwner && !sidebarCollapsed
              ? () => {
                  sections.setOpen("projects", true);
                  setProjectCreateDraft("");
                  setCreatingProject(true);
                }
              : undefined
          )}
          {(sections.isOpen("projects") || sidebarCollapsed) && (
            <div className="sidebar-subitems">
              {creatingProject && (
                <input
                  className="sidebar-project-edit"
                  value={projectCreateDraft}
                  autoFocus
                  placeholder="New project…"
                  aria-label="New project name"
                  onChange={(e) => setProjectCreateDraft(e.target.value)}
                  onBlur={submitNewProject}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNewProject();
                    else if (e.key === "Escape") {
                      setCreatingProject(false);
                      setProjectCreateDraft("");
                    }
                  }}
                />
              )}
              {projects.map((proj) =>
                editingProject === proj.id ? (
                  <input
                    key={proj.id}
                    className="sidebar-project-edit"
                    value={projectDraft}
                    autoFocus
                    aria-label="Project name"
                    onChange={(e) => setProjectDraft(e.target.value)}
                    onBlur={() => commitProjectName(proj.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitProjectName(proj.id);
                      else if (e.key === "Escape") setEditingProject(null);
                    }}
                  />
                ) : (
                  <div key={proj.id} className="sidebar-project-row">
                    <Link
                      to="/github"
                      title={proj.name}
                      className="sidebar-project-label"
                      onClick={(e) => {
                        setNavOpen(false);
                        if (splitTarget === "right") {
                          e.preventDefault();
                          setRightView("github");
                        }
                      }}
                    >
                      {proj.name}
                    </Link>
                    {isOrgOwner && (
                      <button
                        type="button"
                        className="sidebar-project-edit-btn"
                        title="Rename project"
                        aria-label={`Rename ${proj.name}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setProjectDraft(proj.name);
                          setEditingProject(proj.id);
                        }}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )
              )}
              {!creatingProject && projects.length === 0 && (
                <div className="sidebar-empty-hint">No projects yet</div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "teams",
      label: "Teams",
      visible: true,
      onAdd:
        isOrgOwner && !sidebarCollapsed
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
          {teams.map((team) => (
            <Fragment key={team.slug}>
              {renderSidebarLink(
                `/teams/${team.slug}`,
                team.name,
                "👥",
                location.pathname === `/teams/${team.slug}`
              )}
            </Fragment>
          ))}
          {!creatingTeam && teams.length === 0 && (
            <div className="sidebar-empty-hint">No teams yet</div>
          )}
        </div>
      ),
    },
    {
      key: "platform",
      label: "Platform",
      visible: hasPlatformSection,
      links: [
        {
          path: "/platform/billing",
          label: "Billing",
          icon: "💳",
          visible: canAccessPlatformBilling,
        },
        {
          path: "/platform/developer",
          label: "Developer",
          icon: "⚙",
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
          icon: "📊",
          visible: canAccessPlatformAnalytics,
        },
        {
          path: "/platform/domains",
          label: "Domains",
          icon: "🌐",
          visible: isPlatformOwner,
        },
        {
          path: "/platform/secrets",
          label: "Secrets",
          icon: "🔑",
          visible: isPlatformOwner,
        },
      ],
    },
    {
      key: "logs",
      label: "Logs",
      visible: hasLogsSection,
      links: [
        {
          path: "/logs/app",
          label: "App Logs",
          icon: "🪵",
          visible: canAccessPlatformLogs,
        },
        {
          path: "/logs/visitors",
          label: "Visitors",
          icon: "👥",
          visible: isPlatformOwner,
        },
        {
          path: "/logs/users",
          label: "User Logs",
          icon: "👤",
          visible: canAccessSecurity,
        },
        {
          path: "/logs/audit",
          label: "Audit Logs",
          icon: "🔒",
          visible: canAccessSecurity,
        },
        {
          path: "/logs/tracing",
          label: "Tracing",
          icon: "📈",
          visible: isPlatformOwner,
        },
      ],
    },
    {
      key: "developers",
      label: "Developers",
      visible: user.account_type !== "personal",
      links: [
        { path: "/docs", label: "Docs", icon: "📚" },
        { path: "/docs/api", label: "API reference", icon: "📖" },
        // Libraries + SDK both land on the Developer overview; Libraries is
        // never shown as active (preserves prior behavior), SDK is.
        {
          path: "/docs/developers",
          label: "Libraries",
          icon: "📦",
          active: false,
        },
        { path: "/docs/developers", label: "SDK", icon: "🧰" },
        {
          path: "/api-keys",
          label: "API Keys",
          icon: "🔑",
          visible: canAccessApiKeyAdmin(user),
        },
      ],
    },
    {
      key: "organization",
      label: "Organization",
      visible: isOrgOwner,
      collapsible: false,
      links: [
        {
          path:
            user.organization_id != null
              ? `/platform/domains?org=${user.organization_id}`
              : "/platform/domains",
          label: "Domains",
          icon: "🌐",
          activeWhen: "/platform/domains",
        },
        { path: "/logs/app", label: "App Logs", icon: "📊" },
        { path: "/logs/audit", label: "Audit Logs", icon: "🔒" },
      ],
    },
  ];

  return (
    <div className="app">
      <SearchProvider>
        {/* 🔝 HEADER — brand + inline search + global actions. App
          navigation lives in the left sidebar. */}
        <div className="header">
          <div className="header-brand">
            <div className="logo" onClick={() => navigate("/")}>
              <BrandLogo className="logo-mark" size={36} />
              <span className="logo-word">{BRAND_NAME}</span>
            </div>
            {/* Header toggle is the mobile hamburger ONLY. On wide screens the
              show/hide control lives on the sidebar divider (see
              .sidebar-divider-toggle below); there's no persistent divider in
              the ≤768px off-canvas overlay, so the header button stays for it. */}
            {isNarrow && (
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
                  {/* Panel frame for context */}
                  <rect x="3" y="5" width="18" height="14" rx="2.2" />
                  <line x1="9" y1="5" x2="9" y2="19" />
                  {/* Arrow points the way the panel will move on click:
                    open → left chevron (will hide); closed → right (show). */}
                  {navOpen ? (
                    <polyline points="15 9 12 12 15 15" />
                  ) : (
                    <polyline points="12 9 15 12 12 15" />
                  )}
                </svg>
              </button>
            )}
          </div>

          {!location.pathname.startsWith("/emails") &&
            !location.pathname.startsWith("/notes") && <SearchBar />}

          <div className="actions">
            {/* Bug-report shortcut. Always visible to signed-in users so
              issues can be filed from anywhere without first hunting through
              Settings. Same overlay as ProfileMenu's "Help & Report issue".
              Sits before Upgrade so the monetization CTA still has primary
              emphasis on the right edge. */}
            <button
              type="button"
              className="header-bug-btn"
              onClick={() => setSupportOpen(true)}
              title="Report an issue"
              aria-label="Report an issue"
            >
              <BugReportIcon className="header-bug-icon" />
            </button>

            {/* Welcome / role label removed — the signed-in identity is
              already visible via the ProfileMenu avatar on the right.
              Keep the Upgrade nudge here because it's the single most
              clickable monetization surface for free personal accounts. */}
            {isBasicPersonalUser && (
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

            <ProfileMenu />
          </div>
        </div>

        <StorageLimitBanner onUpgrade={goToUpgrade} />

        {/* 🔥 BODY */}
        <div className="body">
          {/* PRIMARY SIDEBAR — every app nav surface lives here. */}
          <nav
            ref={sidebarRef}
            className={`sidebar ${navOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`.trim()}
            style={
              !sidebarCollapsed && !isNarrow
                ? { width: `${sidebarWidth}px` }
                : undefined
            }
            aria-label="Primary navigation"
          >
            {/* Wide-screen show/hide control — a small chevron pinned at the top
              of the panel, above Home. Stays put whether expanded or collapsed
              to the icon rail. The ≤768px overlay uses the header hamburger
              instead, so this is desktop-only. */}
            {!isNarrow && (
              <div className="sidebar-collapse-row">
                <button
                  type="button"
                  className="sidebar-collapse-btn"
                  onClick={() => setSidebarCollapsed((c) => !c)}
                  title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                  aria-label={
                    sidebarCollapsed ? "Show sidebar" : "Hide sidebar"
                  }
                  aria-expanded={!sidebarCollapsed}
                >
                  <svg
                    className="sidebar-collapse-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    {/* Same panel-frame glyph the header toggle used. The arrow
                      points the way the panel will move on click:
                      expanded → left (will hide); collapsed → right (will show). */}
                    <rect x="3" y="5" width="18" height="14" rx="2.2" />
                    <line x1="9" y1="5" x2="9" y2="19" />
                    {sidebarCollapsed ? (
                      <polyline points="12 9 15 12 12 15" />
                    ) : (
                      <polyline points="15 9 12 12 15 15" />
                    )}
                  </svg>
                </button>
              </div>
            )}

            <div className="sidebar-section">
              {renderSidebarItem("/", "home", "Home", "🏠")}
              {renderSidebarItem(
                "/emails",
                "emails",
                "Emails",
                "📧",
                emailsUnreadCount
              )}
              {renderSidebarItem("/chat", "chat", "Chat", "💬")}
              {/* /call is intentionally absent — audio/video lives inside Chat. */}
              {renderSidebarItem("/scheduler", "scheduler", "Scheduler", "📅")}
              {renderSidebarItem("/drive", "drive", "Drive", "📁")}
              {renderSidebarItem("/notes", "notes", "Notes", "📝")}
              {renderSidebarItem("/tasks", "tasks", "Tasks", "☑")}
              {renderSidebarItem("/ai-chat", "aichat", "AI Chat", "✨")}
              {(user.scope === "platform" || user.scope === "organization") &&
                renderSidebarItem(
                  "/test-access",
                  "test_access",
                  "Test Access",
                  "🔓"
                )}
              {(isOrgOwner || isPlatformOwner) &&
                renderSidebarLink(
                  "/access-requests",
                  "Access Requests",
                  "🛂",
                  location.pathname === "/access-requests"
                )}
            </div>

            {sectionDefs.map(renderSection)}

            <div className="sidebar-spacer" />

            {user.account_type !== "platform_admin" &&
              user.account_type !== "personal" &&
              canSeePricing && (
                <div className="sidebar-section sidebar-section-secondary">
                  {renderSidebarLink(
                    "/pricing",
                    "Pricing",
                    "💲",
                    location.pathname === "/pricing"
                  )}
                </div>
              )}
          </nav>

          {/* Drag the nav sidebar wider/narrower (hidden when collapsed to the
            icon rail or in the narrow off-canvas overlay). */}
          {!sidebarCollapsed && !isNarrow && (
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

          {/* MAIN CONTENT */}
          <div className={`content`} ref={contentRef}>
            <div
              className={`split-pane left ${splitTarget === "left" ? "active-target" : ""}`}
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
                        fallback={<div className="split-loading">Loading…</div>}
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

            {/* Resize handle between left and (middle or right) — only when
              split open. Dragging adjusts the boundary between the two
              panes the handle sits between. */}
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
                        fallback={<div className="split-loading">Loading…</div>}
                      >
                        <MiddleComp />
                      </Suspense>
                    </SplitPaneContext.Provider>
                  )}
                </div>
              </div>
            )}

            {/* Second handle only when all three panes are visible — sits
              between center and right. */}
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
                        fallback={<div className="split-loading">Loading…</div>}
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

      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}
    </div>
  );
}
