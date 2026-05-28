import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canAccessApiKeyAdmin, hasPermission } from "../auth/permissions";
import { Suspense, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import SearchProvider from "../search/SearchProvider";
import SearchBar from "../search/SearchBar";
import ProfileMenu from "./ProfileMenu";
import { SPLIT_APPS, type AppKey } from "./LayoutConfig";
import "./Layout.css";

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
  return (
    typeof value === "string" &&
    SPLIT_APPS.some((a) => a.key === value)
  );
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

export default function Layout({ children }: { children?: ReactNode } = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Three-pane state management. Lazy init reads any persisted split
  // from a previous visit; the effect below mirrors changes back.
  const [middleView, setMiddleView] = useState<AppKey | null>(
    () => loadPersistedSplit().middleView,
  );
  const [rightView, setRightView] = useState<AppKey | null>(
    () => loadPersistedSplit().rightView,
  );

  // Decides whether the next header-link click navigates or changes the duplicate pane.
  const [splitTarget, setSplitTarget] = useState<"left" | "right">(
    () => loadPersistedSplit().splitTarget,
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        SPLIT_STORAGE_KEY,
        JSON.stringify({ middleView, rightView, splitTarget }),
      );
    } catch {
      // Storage quota / private mode — silently ignore, split just
      // won't persist across reloads for this session.
    }
  }, [middleView, rightView, splitTarget]);

  // On narrow viewports the header nav collapses behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);

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
        sidebarCollapsed ? "1" : "0",
      );
    } catch {
      // private mode / quota — preference just won't persist this session.
    }
  }, [sidebarCollapsed]);

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
        JSON.stringify(paneWeights),
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
          `.split-pane.${leftKey}`,
        );
        const rightEl = container.querySelector<HTMLElement>(
          `.split-pane.${rightKey}`,
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
            Math.min(maxFraction, rawFraction),
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
    [paneWeights],
  );

  const middleApp = SPLIT_APPS.find((a) => a.key === middleView) ?? null;
  const MiddleComp = middleApp?.Comp ?? null;
  const middleLabel = middleApp?.label ?? null;

  const rightApp = SPLIT_APPS.find((a) => a.key === rightView) ?? null;
  const RightComp = rightApp?.Comp ?? null;
  const rightLabel = rightApp?.label ?? null;
  const leftApp = SPLIT_APPS.find((a) => a.key === appKeyFromPath(location.pathname)) ?? null;
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
    (path: string, app: AppKey, label: string, icon: ReactNode) => {
      const isLeftActive =
        app === "home"
          ? location.pathname === "/" || location.pathname === "/home"
          : location.pathname === path;
      const isMiddleActive = middleView === app;
      const isRightActive = rightView === app;

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
          <span className="sidebar-icon" aria-hidden="true">{icon}</span>
          <span className="sidebar-label">{label}</span>
        </Link>
      );
    },
    [location.pathname, middleView, rightView, splitTarget],
  );

  const renderSidebarLink = (
    path: string,
    label: string,
    icon: ReactNode,
    isActive: boolean,
  ) => (
    <Link
      to={path}
      title={label}
      className={`sidebar-link ${isActive ? "active" : ""}`.trim()}
      onClick={() => setNavOpen(false)}
    >
      <span className="sidebar-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-label">{label}</span>
    </Link>
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
  const canAccessSecurity =
    user.scope === "platform" &&
    (hasPermission(user, "audit:read") || hasPermission(user, "webhooks:manage"));
  // Platform-wide billing console: aggregates revenue, customer subscriptions
  // and payroll across the whole platform. Distinct from the per-tenant
  // [/billing](../billing/Billing.tsx) self-service view; staff-only.
  const canAccessPlatformBilling =
    user.scope === "platform" &&
    (hasPermission(user, "billing:read") || hasPermission(user, "billing:manage"));
  const canAccessPlatformDeveloper =
    user.scope === "platform" &&
    (hasPermission(user, "logs:read") ||
      hasPermission(user, "logs:read_limited") ||
      hasPermission(user, "api_keys:manage"));
  const canAccessPlatformSupport =
    user.scope === "platform" && hasPermission(user, "members:read");
  const currentPlanCode = authedUser.current_plan?.code ?? "basic_user";
  const isBasicPersonalUser =
    authedUser.account_type === "personal" && currentPlanCode === "basic_user";

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
    canAccessSecurity ||
    canAccessPlatformBilling ||
    canAccessPlatformDeveloper ||
    canAccessPlatformSupport;

  return (
    <div className="app">
    <SearchProvider>
      {/* 🔝 HEADER — brand + inline search + global actions. App
          navigation lives in the left sidebar. */}
      <div className="header">
        <div className="header-brand">
          <div className="logo" onClick={() => navigate("/")}>Wayve</div>
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={() => {
              // On narrow viewports the sidebar is an overlay — toggle its
              // open/close state. On wide viewports it's a permanent rail —
              // toggle between expanded (labels) and collapsed (icon-only).
              const isNarrow =
                typeof window !== "undefined" &&
                window.matchMedia("(max-width: 1100px)").matches;
              if (isNarrow) {
                setNavOpen((open) => !open);
              } else {
                setSidebarCollapsed((c) => !c);
              }
            }}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
          >
            <svg
              className="sidebar-toggle-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2.2" />
              <line x1="9" y1="5" x2="9" y2="19" />
              {sidebarCollapsed ? (
                <polyline points="12 9 14 12 12 15" />
              ) : (
                <polyline points="14 9 12 12 14 15" />
              )}
            </svg>
          </button>
        </div>

        {!location.pathname.startsWith("/emails") && <SearchBar />}

        <div className="actions">
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

      {/* 🔥 BODY */}
      <div className="body">
        {/* PRIMARY SIDEBAR — every app nav surface lives here. */}
        <nav
          className={`sidebar ${navOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`.trim()}
          aria-label="Primary navigation"
        >
          <div className="sidebar-section">
            {renderSidebarItem("/", "home", "Home", "🏠")}
            {renderSidebarItem("/emails", "emails", "Emails", "📧")}
            {renderSidebarItem("/chat", "chat", "Chat", "💬")}
            {/* /call is intentionally absent — audio/video lives inside Chat. */}
            {renderSidebarItem("/scheduler", "scheduler", "Scheduler", "📅")}
            {renderSidebarItem("/drive", "drive", "Drive", "📁")}
            {renderSidebarItem("/notes", "notes", "Notes", "📝")}
            {renderSidebarItem("/tasks", "tasks", "Tasks", "☑")}
            {renderSidebarItem("/aichat", "aichat", "AI Chat", "✨")}
            {user.account_type !== "personal" &&
              renderSidebarItem(
                "/github",
                "github",
                "GitHub",
                // Folder with a branch tree inside — picks up currentColor
                // so it follows the link's foreground (white when active).
                <svg
                  className="sidebar-icon-svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                  <circle cx="9" cy="11" r="1.4" />
                  <circle cx="15" cy="11" r="1.4" />
                  <circle cx="12" cy="17" r="1.4" />
                  <path d="M9 12v1a3 3 0 0 0 3 3" />
                  <path d="M15 12v1a3 3 0 0 1-3 3" />
                </svg>,
              )}
          </div>

          {hasPlatformSection && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">Platform</div>
              {canAccessSecurity &&
                renderSidebarLink(
                  "/security/audit",
                  "Security",
                  "🔒",
                  location.pathname.startsWith("/security"),
                )}
              {canAccessPlatformBilling &&
                renderSidebarLink(
                  "/platform/billing",
                  "Billing",
                  "💳",
                  location.pathname === "/platform/billing",
                )}
              {canAccessPlatformDeveloper &&
                renderSidebarLink(
                  "/platform/developer",
                  "Developer",
                  "⚙",
                  location.pathname === "/platform/developer",
                )}
              {canAccessPlatformSupport &&
                renderSidebarLink(
                  "/platform/support",
                  "Support",
                  "🛟",
                  location.pathname === "/platform/support",
                )}
            </div>
          )}

          <div className="sidebar-spacer" />

          <div className="sidebar-section sidebar-section-secondary">
            {user.account_type !== "platform_admin" &&
              user.account_type !== "personal" &&
              renderSidebarLink(
                "/pricing",
                "Pricing",
                "💲",
                location.pathname === "/pricing",
              )}
            {user.account_type !== "personal" && (
              <>
                {renderSidebarLink(
                  "/developers",
                  "Developers",
                  "🛠",
                  location.pathname === "/developers",
                )}
                {renderSidebarLink(
                  "/docs",
                  "Docs",
                  "📚",
                  location.pathname.startsWith("/docs"),
                )}
              </>
            )}
            {canAccessApiKeyAdmin(user) &&
              renderSidebarLink(
                "/api-keys",
                "API Keys",
                "🔑",
                location.pathname === "/api-keys",
              )}
            {renderSidebarItem("/about", "about", "About", "ⓘ")}
          </div>
        </nav>

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
                  {children ?? <Outlet />}
                </div>
              </>
            ) : (
              children ?? <Outlet />
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
                middleView ? "center" : "right",
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
                  <Suspense fallback={<div className="split-loading">Loading…</div>}>
                    <MiddleComp />
                  </Suspense>
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
                  <Suspense fallback={<div className="split-loading">Loading…</div>}>
                    <RightComp />
                  </Suspense>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      </SearchProvider>
    </div>
  );
}
