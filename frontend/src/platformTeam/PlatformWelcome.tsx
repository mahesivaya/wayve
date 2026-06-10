import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { ROLE_LABELS, normalizeRole } from "../auth/permissions";
import "./platformTeam.css";

// Landing page for platform `member` and `guest` roles. Both share the same
// baseline permission bundle (apps:use, profile:manage_self) and have no
// admin surface to operate, so the home is a welcome tile grid pointing at
// the apps they can actually use.
const APP_TILES: Array<{
  path: string;
  icon: string;
  label: string;
  desc: string;
}> = [
  { path: "/emails", icon: "📧", label: "Emails", desc: "Send & receive mail" },
  {
    path: "/chat",
    icon: "💬",
    label: "Chat",
    desc: "Direct & channel messages",
  },
  {
    path: "/scheduler",
    icon: "📅",
    label: "Scheduler",
    desc: "Meetings & calendar",
  },
  { path: "/drive", icon: "📁", label: "Drive", desc: "Files & folders" },
  { path: "/notes", icon: "📝", label: "Notes", desc: "Personal notes" },
  { path: "/tasks", icon: "☑", label: "Tasks", desc: "Your to-do list" },
  { path: "/ai-chat", icon: "✨", label: "AI Chat", desc: "Assistant" },
  { path: "/profile", icon: "👤", label: "Profile", desc: "Account settings" },
];

export default function PlatformWelcome() {
  const { user } = useAuth();
  const isPlatformBaseline =
    user?.scope === "platform" &&
    (user?.effective_role === "member" || user?.effective_role === "guest");

  if (!user) return <Navigate to="/login" replace />;
  if (!isPlatformBaseline) return <Navigate to="/" replace />;

  const roleLabel = ROLE_LABELS[normalizeRole(user.effective_role)];
  const isGuest = user.effective_role === "guest";

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Welcome, {user.email}</h1>
        <p>
          You are signed in to the platform as <strong>{roleLabel}</strong>.
          {isGuest
            ? " Your access is limited to resources that have been explicitly shared with you."
            : " You have access to the standard apps below; admin consoles are hidden from this role."}
        </p>
      </header>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Your access</h2>
        </div>
        <table className="pt-table">
          <tbody>
            <tr>
              <th>Role</th>
              <td>
                <span className="pt-pill info">{roleLabel}</span>
              </td>
            </tr>
            <tr>
              <th>Scope</th>
              <td>Platform</td>
            </tr>
            <tr>
              <th>Permissions</th>
              <td>
                {(user.permissions ?? []).length === 0
                  ? "None"
                  : (user.permissions ?? []).map((perm) => (
                      <code key={perm} style={{ marginRight: 6 }}>
                        {perm}
                      </code>
                    ))}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={{ marginBottom: 12, fontSize: 16 }}>Apps</h2>
        <div className="pt-welcome-tiles">
          {APP_TILES.map((tile) => (
            <Link to={tile.path} className="pt-welcome-tile" key={tile.path}>
              <span className="icon">{tile.icon}</span>
              <strong>{tile.label}</strong>
              <span>{tile.desc}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Need more access?</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
          Admin consoles (members, billing, security, developer tooling) require
          a higher platform role. Reach out to a platform owner or admin to
          request additional permissions for your account.
        </p>
      </section>
    </div>
  );
}
