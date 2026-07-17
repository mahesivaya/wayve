import { useMemo, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewIntegrations } from "../auth/permissions";
import ThemeCustomizer from "../theme/ThemeCustomizer";
import { useCustomTheme } from "../theme/useCustomTheme";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";

// Must stay as var() references, not literal colors: browsers resolve var() in
// inline styles, so the swatch tracks the active palette (custom themes and dark
// mode included) without mirroring any values into React state.
const SWATCH_VARS = [
  "var(--color-primary-action)",
  "var(--color-accent-purple)",
  "var(--color-success)",
] as const;

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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);
  // Re-keying on the choice forces the inline var() values to re-resolve.
  const { choice } = useCustomTheme();
  const swatchKey = useMemo(() => JSON.stringify(choice), [choice]);

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

  // The Appearance panel needs its own outside-click handler because it renders
  // outside the profile-menu wrapper, so the menu's handler would otherwise fire
  // when the user drags a slider inside the customizer.
  useEffect(() => {
    if (!appearanceOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        appearanceRef.current &&
        e.target instanceof Node &&
        !appearanceRef.current.contains(e.target)
      ) {
        setAppearanceOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAppearanceOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [appearanceOpen]);

  if (!user) return null;

  const inSidebar = placement === "sidebar";

  return (
    <div className={`profile-menu profile-menu--${placement}`} ref={menuRef}>
      <button
        className="profile-trigger"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        title={user.email}
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
            onClick={() => {
              setMenuOpen(false);
              void navigate("/profile");
            }}
          >
            <span className="profile-dropdown-icon">👤</span>
            My Profile
          </button>

          <button
            className="profile-dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              void navigate("/settings");
            }}
          >
            <span className="profile-dropdown-icon">⚙️</span>
            Settings & Privacy
          </button>

          {canViewIntegrations(user) && (
            <button
              className="profile-dropdown-item"
              onClick={() => {
                setMenuOpen(false);
                void navigate("/integrations");
              }}
            >
              <span className="profile-dropdown-icon">🔌</span>
              Integrations
            </button>
          )}

          <button
            className="profile-dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              setAppearanceOpen(true);
            }}
          >
            <span className="profile-dropdown-icon">🎨</span>
            Appearance
            <span className="profile-dropdown-item-right">
              <span className="profile-dropdown-swatch" key={swatchKey}>
                {SWATCH_VARS.map((v, i) => (
                  <span key={i} style={{ background: v }} />
                ))}
              </span>
              <span className="profile-dropdown-chevron">›</span>
            </span>
          </button>

          {showSwitcher && (
            <>
              <div className="profile-dropdown-divider" />
              <button
                className="profile-dropdown-item"
                disabled={switching}
                onClick={() =>
                  void handleSwitch(inAdminMode ? "normal" : "admin")
                }
              >
                <span className="profile-dropdown-icon">
                  {inAdminMode ? "🚪" : "🛡️"}
                </span>
                {switching
                  ? "Switching…"
                  : inAdminMode
                    ? "Exit admin mode"
                    : "Switch to admin mode"}
              </button>
            </>
          )}

          <div className="profile-dropdown-divider" />

          <button
            className="profile-dropdown-item profile-dropdown-logout"
            onClick={() => {
              setMenuOpen(false);
              // logout() owns the redirect. Navigating here instead would bounce
              // to the account home while `user` is still set, causing a flash.
              logout();
            }}
          >
            <span className="profile-dropdown-icon">⏻</span>
            Log out
          </button>
        </div>
      )}

      {appearanceOpen && (
        <div
          className="appearance-panel"
          role="dialog"
          aria-label="Appearance"
          ref={appearanceRef}
        >
          <ThemeCustomizer />
        </div>
      )}
    </div>
  );
}
