import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

export default function ProfileMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

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
        <span className="profile-avatar">
          {(user.email?.[0] ?? "?").toUpperCase()}
        </span>
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
              navigate("/profile");
            }}
          >
            <span className="profile-dropdown-icon">👤</span>
            My Profile
          </button>

          <button
            className="profile-dropdown-item"
            onClick={() => {
              setMenuOpen(false);
              navigate("/settings");
            }}
          >
            <span className="profile-dropdown-icon">⚙️</span>
            Settings & Privacy
          </button>

          <div className="profile-dropdown-divider" />

          <button
            className="profile-dropdown-item profile-dropdown-logout"
            onClick={() => {
              setMenuOpen(false);
              logout();
              navigate("/");
            }}
          >
            <span className="profile-dropdown-icon">⏻</span>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
