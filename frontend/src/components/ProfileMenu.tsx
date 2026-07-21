import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewIntegrations } from "../auth/permissions";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";

export default function ProfileMenu({
  placement = "header",
}: { placement?: "header" | "sidebar" } = {}) {
  const { user, logout, switchMode } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const inAdminMode = user?.mode === "admin";
  // Eligible owners see this, plus anyone already elevated so they can exit.
  const showSwitcher = inAdminMode || (user?.can_switch_admin ?? false);

  const handleSwitch = async (target: "normal" | "admin") => {
    if (switching) return;
    setSwitching(true);
    try {
      await switchMode(target);
      setMenuOpen(false);
      navigate(
        target === "admin"
          ? homePathForUser({ ...user, mode: "admin", can_switch_admin: true })
          : "/home"
      );
    } catch {
      // Server refused (e.g. no longer eligible); leave the menu as-is.
    } finally {
      setSwitching(false);
    }
  };
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

  return (
    <div className={`profile-menu profile-menu--${placement}`} ref={menuRef}>
      <button
        className="profile-trigger"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        data-tooltip={user.email}
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
          <div className="profile-dropdown-header">
            <div className="profile-dropdown-name">{user.email}</div>
          </div>

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

          {canViewIntegrations(user) && (
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

          <button
            className="profile-dropdown-item"
            title="Appearance"
            onClick={() => {
              setMenuOpen(false);
              void navigate("/appearance");
            }}
          >
            <span className="profile-dropdown-icon">🎨</span>
            <span className="profile-dropdown-label">Appearance</span>
          </button>

          {showSwitcher && (
            <>
              <div className="profile-dropdown-divider" />
              <button
                className="profile-dropdown-item"
                disabled={switching}
                title={
                  inAdminMode ? "Exit admin mode" : "Switch to admin mode"
                }
                onClick={() =>
                  void handleSwitch(inAdminMode ? "normal" : "admin")
                }
              >
                <span className="profile-dropdown-icon">
                  {inAdminMode ? "🚪" : "🛡️"}
                </span>
                <span className="profile-dropdown-label">
                  {switching
                    ? "Switching…"
                    : inAdminMode
                      ? "Exit admin mode"
                      : "Switch to admin mode"}
                </span>
              </button>
            </>
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
