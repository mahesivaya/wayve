import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { canViewIntegrations } from "../auth/permissions";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";
import { ChevronUp, LogOut as LogOutIcon } from "lucide-react";
import { PlatformIcon, SettingsIcon } from "../icons";

export default function ProfileMenu({
  placement = "header",
  minimal = false,
  platformAdminPath,
}: {
  placement?: "header" | "sidebar";
  // Only Settings and Log out. For wide screens, where
  // Settings' left rail (SettingsShell) already carries Profile and Integrations.
  // Appearance is never in this menu: it lives in Settings (the rail on wide
  // screens, a card on the General page on narrow ones).
  minimal?: boolean;
  // Where the gear menu's "Platform admin" item goes; omitted for users who
  // can't open any Platform page, which hides the item.
  platformAdminPath?: string;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!user) return null;

  const inSidebar = placement === "sidebar";

  // The account row shows the username when there is one, else the email.
  const displayName = user.username?.trim() || user.email;

  const go = (path: string) => {
    setMenuOpen(false);
    void navigate(path);
  };

  // Wide screens: the sidebar's account control is the profile picture and
  // name. It opens a small menu: Settings, Platform admin (platform admins
  // only) and Log out.
  if (inSidebar && minimal) {
    return (
      <div className="profile-menu profile-menu--sidebar" ref={menuRef}>
        <button
          type="button"
          className="profile-trigger profile-settings-trigger"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={user.email}
          aria-label={`Account menu for ${displayName}`}
        >
          <Avatar
            className="profile-avatar"
            name={user.email}
            src={`${getApiBase()}/api/users/${user.id}/avatar`}
            size={22}
          />
          <span className="sidebar-label">{displayName}</span>
          {/* The menu opens upward; the arrow flips while it's open. */}
          <ChevronUp
            className={`profile-menu-chevron${menuOpen ? " open" : ""}`}
            size={16}
            aria-hidden="true"
          />
        </button>

        {menuOpen && (
          <div className="profile-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              className="profile-dropdown-item"
              title="Settings"
              onClick={() => go("/settings")}
            >
              <span className="profile-dropdown-icon" aria-hidden="true">
                <SettingsIcon size={18} />
              </span>
              <span className="profile-dropdown-label">Settings</span>
            </button>
            {platformAdminPath && (
              <button
                type="button"
                role="menuitem"
                className="profile-dropdown-item"
                title="Platform admin"
                onClick={() => go(platformAdminPath)}
              >
                <span className="profile-dropdown-icon" aria-hidden="true">
                  <PlatformIcon size={18} />
                </span>
                <span className="profile-dropdown-label">Platform admin</span>
              </button>
            )}
            <div className="profile-dropdown-divider" />
            <button
              type="button"
              role="menuitem"
              className="profile-dropdown-item profile-dropdown-logout"
              title="Log out"
              onClick={() => {
                setMenuOpen(false);
                // logout() owns the redirect (see the full menu below).
                logout();
              }}
            >
              <span className="profile-dropdown-icon" aria-hidden="true">
                <LogOutIcon size={18} />
              </span>
              <span className="profile-dropdown-label">Log out</span>
            </button>
          </div>
        )}
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
