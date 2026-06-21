import { useMemo, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import ThemeCustomizer from "../theme/ThemeCustomizer";
import { useCustomTheme } from "../theme/useCustomTheme";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";

// Three "identity" CSS variables — used as inline backgrounds on the
// Appearance menu item's mini swatch. Browsers resolve var() in inline
// `style={{ background: 'var(--…)' }}`, so the swatch always reflects the
// active palette (including custom themes) without us having to mirror the
// values into React state.
const SWATCH_VARS = [
  "var(--color-primary-action)",
  "var(--color-accent-purple)",
  "var(--color-success)",
] as const;

export default function ProfileMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);
  // Re-key the swatch when the choice changes so the inline var() values
  // re-resolve. The colors themselves come straight from CSS variables.
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

  // Separate handler for the Appearance panel — it's rendered outside the
  // profile-menu wrapper so the menu's outside-click doesn't fire when the
  // user drags a slider inside the customizer.
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

  return (
    <div className="profile-menu" ref={menuRef}>
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
          size={30}
        />
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

          <div className="profile-dropdown-divider" />

          <button
            className="profile-dropdown-item profile-dropdown-logout"
            onClick={() => {
              setMenuOpen(false);
              // logout() owns the redirect (hard nav to "/"). A client-side
              // navigate here would bounce to the account home while `user`
              // is still set — an extra flash.
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
