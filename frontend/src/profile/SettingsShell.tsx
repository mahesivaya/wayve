import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import "./profile.css";

import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewIntegrations } from "../auth/permissions";
import { isDesktopApp } from "../utils/desktop";

// Desktop shell only: the Account links that live in the header ProfileMenu
// dropdown on the web (which the desktop shell hides). Docked as a left
// sidebar and rendered by SettingsShell on Settings, My Profile and
// Integrations alike, so the menu stays put while navigating between them.
function SettingsSideNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, switchMode } = useAuth();

  // The admin-mode toggle also lives only in the header ProfileMenu on the
  // web, so the desktop shell would otherwise strand an owner in normal mode
  // with no way to elevate. Mirror the ProfileMenu switcher here.
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
// Integrations): page title on top, then the Account sidebar (desktop shell
// only) beside the page's own cards. On the web it degrades to the plain
// single-column stack these pages always had.
export default function SettingsShell({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const desktop = isDesktopApp();

  // Web: the plain centered stack these pages always had.
  if (!desktop) {
    return (
      <div className="settings-page">
        <div className="settings-stack">
          <h1 className="settings-page-title">{title}</h1>
          {children}
        </div>
      </div>
    );
  }

  // Desktop shell: the settings menu is a full-height left sidebar (standing
  // in for the hidden main app sidebar); the content pane scrolls beside it.
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
