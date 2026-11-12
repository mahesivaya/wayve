import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { canViewIntegrations } from "../auth/permissions";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";

export default function ProfileMenu({
  placement = "header",
  minimal = false,
}: {
  placement?: "header" | "sidebar";
  // Only Settings and Log out. For wide screens, where
  // Settings' left rail (SettingsShell) already carries Profile and Integrations.
  // Appearance is never in this menu: it lives in Settings (the rail on wide
  // screens, a card on the General page on narrow ones).
  minimal?: boolean;
} = {}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  if (!user) return null;

  const inSidebar = placement === "sidebar";

  // Wide screens: the sidebar's account control is a Settings gear (with a
  // small avatar badge) that opens Settings directly — its left rail carries
  // Profile, Integrations, Appearance and Log out.
  if (inSidebar && minimal) {
    return (
      <div className="profile-menu profile-menu--sidebar">
        <button
          type="button"
          className="profile-trigger profile-settings-trigger"
          onClick={() => void navigate("/settings")}
          title={`Settings — ${user.email}`}
          aria-label="Settings"
        >
          <span className="profile-settings-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <Avatar
              className="profile-settings-badge"
              name={user.email}
              src={`${getApiBase()}/api/users/${user.id}/avatar`}
              size={14}
            />
          </span>
          <span className="sidebar-label">Settings</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`profile-menu profile-menu--${placement}`} ref={menuRef}>
      <button
        className="profile-trigger"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        data-tooltip={user.email}
        // Pinned to the sidebar bottom, a below-tooltip lands past the scroll
        // area's end and is only reachable by scrolling, so flip it above.
        data-tooltip-pos={inSidebar ? "top" : undefined}
        data-tooltip-align={inSidebar ? "left" : undefined}
        aria-label={user.email}
      >
        <Avatar
          className="profile-avatar"
          name={user.email}
          src={`${getApiBase()}/api/users/${user.id}/avatar`}
          size={inSidebar ? 22 : 30}
        />
        {inSidebar && <span className="sidebar-label">{user.email}</span>}
      </button>

      {menuOpen && (
        <div className="profile-dropdown" role="menu">
          {!minimal && (
            <button
              className="profile-dropdown-item"
              title="My Profile"
              onClick={() => {
                setMenuOpen(false);
                void navigate("/profile");
              }}
            >
              <span className="profile-dropdown-icon">👤</span>
              <span className="profile-dropdown-label">My Profile</span>
            </button>
          )}

          <button
            className="profile-dropdown-item"
            title="Settings & Privacy"
            onClick={() => {
              setMenuOpen(false);
              void navigate("/settings");
            }}
          >
            <span className="profile-dropdown-icon">⚙️</span>
            <span className="profile-dropdown-label">Settings & Privacy</span>
          </button>

          {!minimal && canViewIntegrations(user) && (
            <button
              className="profile-dropdown-item"
              title="Integrations"
              onClick={() => {
                setMenuOpen(false);
                void navigate("/integrations");
              }}
            >
              <span className="profile-dropdown-icon">🔌</span>
              <span className="profile-dropdown-label">Integrations</span>
            </button>
          )}

          <div className="profile-dropdown-divider" />

          <button
            className="profile-dropdown-item profile-dropdown-logout"
            title="Log out"
            onClick={() => {
              setMenuOpen(false);
              // logout() owns the redirect. Navigating here instead would bounce
              // to the account home while `user` is still set, causing a flash.
              logout();
            }}
          >
            <span className="profile-dropdown-icon">⏻</span>
            <span className="profile-dropdown-label">Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
