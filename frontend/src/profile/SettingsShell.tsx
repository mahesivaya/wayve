import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import "./profile.css";

import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewIntegrations } from "../auth/permissions";
import { useIsNarrow } from "../components/useIsNarrow";

// The Account links that otherwise live in the ProfileMenu dropdown, docked as
// a left rail and rendered by SettingsShell on Settings, My Profile and
// Integrations alike, so the menu stays put while navigating between them. It
// stands in for the main sidebar, which Layout hides on these routes — hence
// the Back to Home link. The admin-mode switch lives in the ProfileMenu,
// between Settings and Log out.
function SettingsSideNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const linkClass = (path: string) =>
    `settings-account-link${location.pathname === path ? " active" : ""}`;

  return (
    <aside className="settings-side">
      <section className="settings-card">
        <h2 className="settings-card-title">Settings</h2>
        <div className="settings-rows">
          {/* The main sidebar is hidden while settings has taken over, so
            this is the one road back to the app. */}
          <button
            type="button"
            className="settings-account-link settings-back-link"
            onClick={() =>
              void navigate(user ? homePathForUser(user) : "/home")
            }
          >
            <span className="settings-account-link-icon">←</span>
            <span>Back to Home</span>
          </button>
          <button
            type="button"
            className={linkClass("/settings")}
            onClick={() => void navigate("/settings")}
          >
            <span className="settings-account-link-icon">⚙️</span>
            <span>General</span>
          </button>
          <button
            type="button"
            className={linkClass("/settings/usage")}
            onClick={() => void navigate("/settings/usage")}
          >
            <span className="settings-account-link-icon">📊</span>
            <span>Usage</span>
          </button>
          {/* Platform users have no billing cards; mirrors Settings' gate. */}
          {user?.scope !== "platform" && (
            <button
              type="button"
              className={linkClass("/settings/billing")}
              onClick={() => void navigate("/settings/billing")}
            >
              <span className="settings-account-link-icon">💳</span>
              <span>Billing</span>
            </button>
          )}
          <button
            type="button"
            className={linkClass("/profile")}
            onClick={() => void navigate("/profile")}
          >
            <span className="settings-account-link-icon">👤</span>
            <span>My Profile</span>
          </button>
          {canViewIntegrations(user) && (
            <button
              type="button"
              className={linkClass("/integrations")}
              onClick={() => void navigate("/integrations")}
            >
              <span className="settings-account-link-icon">🔌</span>
              <span>Integrations</span>
            </button>
          )}
          <button
            type="button"
            className={linkClass("/appearance")}
            onClick={() => void navigate("/appearance")}
          >
            <span className="settings-account-link-icon">🎨</span>
            <span>Appearance</span>
          </button>
          {/* Docs / API / SDK / keys used to be a collapsible group in the main
            sidebar. Same gate the group carried: not for personal accounts. */}
          {user?.account_type !== "personal" && (
            <button
              type="button"
              className={linkClass("/settings/developers")}
              onClick={() => void navigate("/settings/developers")}
            >
              <span className="settings-account-link-icon">{"</>"}</span>
              <span>Developers</span>
            </button>
          )}
          <button
            type="button"
            className="settings-account-link settings-account-logout"
            onClick={() => logout()}
          >
            <span className="settings-account-link-icon">⏻</span>
            <span>Log out</span>
          </button>
        </div>
      </section>
    </aside>
  );
}

// Shared scaffolding for the settings-family pages (Settings, My Profile,
// Integrations): page title on top, then the Account rail beside the page's own
// cards. Both runtimes get the same view; only narrow screens degrade to the
// plain single-column stack.
export default function SettingsShell({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  // Must agree with Layout's `settingsTakeover`, which hides the main sidebar
  // exactly when this rail stands in for it.
  const narrow = useIsNarrow();

  // Narrow: the plain centered stack, with the main sidebar still in place.
  if (narrow) {
    return (
      <div className="settings-page">
        <div className="settings-stack">
          <h1 className="settings-page-title">{title}</h1>
          {children}
        </div>
      </div>
    );
  }

  // Wide: the settings menu is a full-height left rail (standing in for the
  // hidden main app sidebar); the content pane scrolls beside it.
  return (
    <div className="settings-page settings-page--split">
      <SettingsSideNav />
      <div className="settings-content">
        <div className="settings-stack">
          <h1 className="settings-page-title">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}
