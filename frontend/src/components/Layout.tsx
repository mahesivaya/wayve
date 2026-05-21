import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { canAccessPricingForUser } from "../auth/accountHome";
import { canAccessApiKeyAdmin } from "../auth/permissions";
import { Suspense, useState, useCallback } from "react";
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

export default function Layout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Three-pane state management
  const [middleView, setMiddleView] = useState<AppKey | null>(null);
  const [rightView, setRightView] = useState<AppKey | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // Decides whether the next header-link click navigates or changes the duplicate pane.
  const [splitTarget, setSplitTarget] = useState<"left" | "right">("left");

  // On narrow viewports the header nav collapses behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);

  const middleApp = SPLIT_APPS.find((a) => a.key === middleView) ?? null;
  const MiddleComp = middleApp?.Comp ?? null;
  const middleLabel = middleApp?.label ?? null;

  const rightApp = SPLIT_APPS.find((a) => a.key === rightView) ?? null;
  const RightComp = rightApp?.Comp ?? null;
  const rightLabel = rightApp?.label ?? null;

  function duplicateCurrentApp() {
    setRightView(appKeyFromPath(location.pathname));
    setSplitTarget("right");
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

  return (
    <div className={`app ${!sidebarOpen ? "sidebar-collapsed" : ""}`}>
      {/* 🔝 HEADER */}
      <div className="header">
        <div className="header-brand">
          {!sidebarOpen && (
            <button
              className="header-sidebar-toggle"
              onClick={() => setSidebarOpen(true)}
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              »
            </button>
          )}
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
          {renderNavItem("/drive", "drive", "Files")}
          {renderNavItem("/notes", "notes", "Notes")}
          {renderNavItem("/tasks", "tasks", "Tasks")}
          {renderNavItem("/aichat", "aichat", "AI Chat")}
          {/* Pricing: hidden from regular organization members (covered by
              the organization subscription); shown to everyone else. */}
          {canAccessPricingForUser(user) && (
            <Link
              to="/pricing"
              className={location.pathname === "/pricing" ? "active" : ""}
              onClick={() => setNavOpen(false)}
            >
              Pricing
            </Link>
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
          {/* Welcome message — shows the signed-in account (platform /
              organization / personal) and its role; handy for RBAC testing. */}
          <div className="header-welcome" title={`Role: ${user.role_label ?? "—"}`}>
            <span className="header-welcome-text">
              Welcome, <strong>{user.email}</strong>
            </span>
            {user.role_label && (
              <span className="header-welcome-role">{user.role_label}</span>
            )}
          </div>

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

          <ProfileMenu />
        </div>
      </div>

      <SearchProvider>
        <SearchBar />

      {/* 🔥 BODY */}
      <div className="body">
        {/* LEFT ICON BAR */}
        <div className="icon-sidebar">
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarOpen(false)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            «
          </button>
          <Link to="/emails">📧</Link>
          <Link to="/chat">💬</Link>
          <Link to="/scheduler">📅</Link>
          <Link to="/drive">📁</Link>
          <Link to="/notes">📝</Link>
          <Link to="/tasks">☑</Link>
          <Link to="/aichat">✨</Link>
          <Link to="/about">ⓘ</Link>

          <div className="icon-sidebar-spacer" />
        </div>

        {/* MAIN CONTENT */}
        <div className={`content`}>
          <div
            className={`split-pane left ${splitTarget === "left" ? "active-target" : ""}`}
            onMouseDown={() => setSplitTarget("left")}
          >
            <Outlet />
          </div>

          {middleView && (
            <div className="split-pane center">
              <div className="split-pane-toolbar">
                <span className="split-pane-title">{middleLabel}</span>
                <button className="split-close-btn" onClick={() => setMiddleView(null)}>✕</button>
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
                <button className="split-close-btn" onClick={() => {
                  setRightView(null);
                  setSplitTarget("left");
                }}>✕</button>
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
