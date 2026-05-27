import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { canAccessApiKeyAdmin, hasPermission } from "../auth/permissions";
import { Suspense, useState, useCallback, useEffect, type ReactNode } from "react";
import SearchProvider from "../search/SearchProvider";
import SearchBar from "../search/SearchBar";
import ProfileMenu from "./ProfileMenu";
import SupportModal from "../support/SupportModal";
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

  // Support modal: opens from the header button, closes via the modal's own
  // close action or Esc. Lives at layout scope so every signed-in page can
  // reach support without each one re-wiring the affordance.
  const [supportOpen, setSupportOpen] = useState(false);

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

  // When the split is open, header link clicks target the right pane instead
  // of navigating the URL. When closed, the link behaves normally.
  const renderNavItem = useCallback((path: string, app: AppKey, label: string) => {
    const isLeftActive = location.pathname === path;
    const isMiddleActive = middleView === app;
    const isRightActive = rightView === app;

    return (
      <Link
        key={app}
        to={path}
        className={`${isLeftActive ? "active" : ""} ${isMiddleActive || isRightActive ? "active-split" : ""}`.trim()}
        onClick={(e) => {
          setNavOpen(false);
          if (splitTarget === "right") {
            e.preventDefault();
            setRightView(app);
          }
        }}
      >
        {label}
      </Link>
    );
  }, [location.pathname, middleView, rightView, splitTarget]);

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

  return (
    <div className="app">
      {/* 🔝 HEADER */}
      <div className="header">
        <div className="header-brand">
          <div className="logo" onClick={() => navigate("/")}>Wayve </div>
          <button
            className="nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            title="Menu"
            aria-label="Toggle navigation menu"
            aria-expanded={navOpen}
          >
            ☰
          </button>
        </div>

        <div className={`nav ${navOpen ? "open" : ""}`}>
          {renderNavItem("/", "home", "Home")}
          {renderNavItem("/emails", "emails", "Emails")}
          {renderNavItem("/chat", "chat", "Chat")}
          {/* /call is no longer in the top nav — audio/video controls live
              inside [Chat](../chat/Chat.tsx)'s conversation header. The route
              is still reachable for legacy bookmarks. */}
          {renderNavItem("/scheduler", "scheduler", "Scheduler")}
          {renderNavItem("/drive", "drive", "Drive")}
          {renderNavItem("/notes", "notes", "Notes")}
          {renderNavItem("/tasks", "tasks", "Tasks")}
          {renderNavItem("/aichat", "aichat", "AI Chat")}
          {/* Pricing: hidden for platform members (they administer the
              platform, not customers of it) and for personal accounts
              (they reach the upgrade flow via Settings → "Manage billing
              & upgrade", which is the canonical path for them). */}
          {user.account_type !== "platform_admin" &&
            user.account_type !== "personal" && (
              <Link
                to="/pricing"
                className={location.pathname === "/pricing" ? "active" : ""}
                onClick={() => setNavOpen(false)}
              >
                Pricing
              </Link>
            )}
          {/* Developers + Docs are dev-tooling surfaces — hidden for
              personal accounts where they're noise (no API keys, no
              webhooks, no integrations to read about). */}
          {user.account_type !== "personal" && (
            <>
              <Link
                to="/developers"
                className={location.pathname === "/developers" ? "active" : ""}
                onClick={() => setNavOpen(false)}
              >
                Developers
              </Link>
              <Link
                to="/docs"
                className={location.pathname.startsWith("/docs") ? "active" : ""}
                onClick={() => setNavOpen(false)}
              >
                Docs
              </Link>
            </>
          )}
          {/* API Keys admin surface: visible only to org/platform
              owner, super_admin, and admin. See [canAccessApiKeyAdmin](../auth/permissions.ts)
              for the rationale (intentionally stricter than the raw
              `api_keys:manage` permission, which Developer also holds). */}
          {canAccessApiKeyAdmin(user) && (
            <Link
              to="/api-keys"
              className={location.pathname === "/api-keys" ? "active" : ""}
              onClick={() => setNavOpen(false)}
            >
              API Keys
            </Link>
          )}
          {renderNavItem("/about", "about", "About")}
        </div>

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
              <rect x="3" y="4" width="18" height="16" rx="1.8" />
              <path d="M3 8.5h18" />
              <path d="M12 8.5V20" />
            </svg>
          </button>

          <button
            type="button"
            className="header-support-btn"
            onClick={() => setSupportOpen(true)}
            title="Contact support"
            aria-label="Open support"
          >
            <span aria-hidden="true">💬</span>
            <span>Support</span>
          </button>

          <ProfileMenu />
        </div>
      </div>

      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}

      <SearchProvider>
        <SearchBar />

      {/* 🔥 BODY */}
      <div className="body">
        {/* LEFT ICON BAR */}
        <div className="icon-sidebar">
          <Link to="/emails">📧</Link>
          <Link to="/chat">💬</Link>
          <Link to="/scheduler">📅</Link>
          <Link to="/drive">📁</Link>
          <Link to="/notes">📝</Link>
          <Link to="/tasks">☑</Link>
          <Link to="/aichat">✨</Link>
          {canAccessSecurity && <Link to="/security/audit">🔒</Link>}
          {canAccessPlatformBilling && <Link to="/platform/billing" title="Platform billing">💳</Link>}
          {canAccessPlatformDeveloper && <Link to="/platform/developer" title="Developer console">⚙</Link>}
          {canAccessPlatformSupport && <Link to="/platform/support" title="Support console">🛟</Link>}
          <Link to="/about">ⓘ</Link>

          <div className="icon-sidebar-spacer" />
        </div>

        {/* MAIN CONTENT */}
        <div className={`content`}>
          <div
            className={`split-pane left ${splitTarget === "left" ? "active-target" : ""}`}
            onMouseDown={() => setSplitTarget("left")}
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

          {middleView && (
            <div className="split-pane center">
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

          {rightView && (
            <div
              className={`split-pane right ${splitTarget === "right" ? "active-target" : ""}`}
              onMouseDown={() => setSplitTarget("right")}
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
