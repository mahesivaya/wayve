import { useNavigate } from "react-router-dom";
import type { KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import "../home/home.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

export default function OrganizationAdminHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canSeeMembers =
    hasPermission(user, "members:read") || hasPermission(user, "members:manage");

  // Enter / Space keyboard activation so the article behaves like a
  // button for screen-reader + keyboard users.
  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    path: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(path);
    }
  };

  return (
    <div className="organization-admin-home u-page-shell">
      <div className="organization-admin-header u-panel u-flex-between">
        <div>
          <h1>Welcome {user?.role_label ?? "Organization member"}</h1>
          <p>{user?.email}</p>
        </div>
      </div>

      {canSeeMembers && (
        <section className="organization-admin-panel u-panel">
          <div className="organization-admin-section-header">
            <div>
              <h2>Organization consoles</h2>
              <p>Admin surfaces for managing your organization.</p>
            </div>
          </div>
          <div className="organization-name-list platform-console-list">
            <article
              className="u-card-interactive"
              role="button"
              tabIndex={0}
              aria-label="Open Members & roles"
              onClick={() => navigate("/organization/members")}
              onKeyDown={(event) =>
                handleCardKeyDown(event, "/organization/members")
              }
            >
              <strong>Members & roles</strong>
              <span>Create accounts inside your organization and adjust their roles.</span>
            </article>
          </div>
        </section>
      )}

      <div className="organization-admin-grid">
        <article className="u-card" onClick={() => navigate("/emails")}>
          <h3>Mail</h3>
          <p>Manage organization communication from the shared workspace.</p>
        </article>
        <article className="u-card" onClick={() => navigate("/chat")}>
          <h3>Team Chat</h3>
          <p>Create channels, manage members, and coordinate team work.</p>
        </article>
        <article className="u-card" onClick={() => navigate("/tasks")}>
          <h3>Tasks</h3>
          <p>Create and track action items for organization workflows.</p>
        </article>
        <article className="u-card" onClick={() => navigate("/scheduler")}>
          <h3>Scheduler</h3>
          <p>Review meetings and plan team schedules.</p>
        </article>
      </div>
    </div>
  );
}
