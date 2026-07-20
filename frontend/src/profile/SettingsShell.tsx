import { useState, type ReactNode } from "react";
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
// the Back to Home link and the admin-mode switch.
function SettingsSideNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, switchMode } = useAuth();

  // The admin-mode toggle otherwise lives only in the ProfileMenu, which is
  // out of reach while settings has taken the sidebar over — without this an
  // owner would be stranded in normal mode. Mirror the ProfileMenu switcher.
  const [switchingMode, setSwitchingMode] = useState(false);
  const inAdminMode = user?.mode === "admin";
  const showModeSwitcher = inAdminMode || (user?.can_switch_admin ?? false);

  const handleSwitchMode = async (target: "normal" | "admin") => {
    if (switchingMode) return;
    setSwitchingMode(true);
    try {
      await switchMode(target);
      navigate(
        target === "admin"
          ? homePathForUser({ ...user, mode: "admin", can_switch_admin: true })
          : "/home"
      );
    } catch {
      // Server refused (e.g. no longer eligible); leave the page as-is.
    } finally {
      setSwitchingMode(false);
    }
  };

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
          {showModeSwitcher && (
            <button
              type="button"
              className="settings-account-link"
              disabled={switchingMode}
              onClick={() =>
                void handleSwitchMode(inAdminMode ? "normal" : "admin")
              }
            >
              <span className="settings-account-link-icon">
                {inAdminMode ? "🚪" : "🛡️"}
              </span>
              <span>
                {switchingMode
                  ? "Switching…"
                  : inAdminMode
                    ? "Exit admin mode"
                    : "Switch to admin mode"}
              </span>
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
