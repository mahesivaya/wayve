import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createAdminUser, type AdminCreatedUser } from "../api/admin";
import { slugify, getEmailDomain } from "../auth/accountHome";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import MembersRolesPanel from "./MembersRolesPanel";
import "../home/home.css";
import "./organizationAdmin.css";

// Organization admins create accounts for users inside their own organization.
// The new account is always an "organization" account on the organization
// email domain; provisioning organizations + organization admins is the
// platform admin's job.
export default function OrganizationAdminHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManageMembers = hasPermission(user, "members:manage");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [createdUsers, setCreatedUsers] = useState<AdminCreatedUser[]>([]);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [creating, setCreating] = useState(false);

  // New accounts land on the organization's email domain — the org slug if
  // set, otherwise a slug derived from the organization name. No placeholder.
  const orgSlug =
    user?.organization_slug || slugify(user?.organization_name ?? "");
  const emailDomain = getEmailDomain(orgSlug);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreateSuccess("");
    setCreating(true);

    try {
      const email = `${slugify(handle)}@${emailDomain}`;
      const created = await createAdminUser(handle, email, password);
      setCreatedUsers((prev) => [created, ...prev]);
      setHandle("");
      setPassword("");
      setCreateSuccess(`Created account ${created.email}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="organization-admin-home">
      <div className="organization-admin-header">
        <div>
          <h1>Welcome {user?.role_label ?? "Organization member"}</h1>
          <p>{user?.email}</p>
        </div>
      </div>

      {canManageMembers && (
      <section className="organization-admin-create">
        <div className="organization-admin-section-header">
          <div>
            <h2>Create account</h2>
            <p>
              Add a new account inside your organization. Enter a handle - the
              email is generated automatically.
            </p>
          </div>
        </div>

        <form className="organization-admin-form" onSubmit={createUser}>
          <label>
            <span>Handle</span>
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="e.g. john"
              required
            />
          </label>

          {handle && (
            <p className="organization-admin-hint">
              Login email will be{" "}
              <strong>
                {slugify(handle)}@{emailDomain}
              </strong>
            </p>
          )}

          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 6 characters"
              minLength={6}
              required
            />
          </label>

          <button type="submit" disabled={creating}>
            {creating ? "Creating..." : "Create account"}
          </button>
        </form>

        {createError && <div className="organization-admin-error">{createError}</div>}
        {createSuccess && <div className="organization-admin-success">{createSuccess}</div>}

        {createdUsers.length > 0 && (
          <div className="organization-admin-created-list">
            {createdUsers.map((created) => (
              <div key={created.id} className="organization-admin-created-row">
                <strong>{created.username || created.email}</strong>
                <span>{created.email} · {created.account_type}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {user?.organization_id != null && (
        <MembersRolesPanel
          scope="organization"
          organizationId={user.organization_id}
        />
      )}

      <div className="organization-admin-grid">
        <article onClick={() => navigate("/emails")}>
          <h3>Mail</h3>
          <p>Manage organization communication from the shared workspace.</p>
        </article>
        <article onClick={() => navigate("/chat")}>
          <h3>Team Chat</h3>
          <p>Create channels, manage members, and coordinate team work.</p>
        </article>
        <article onClick={() => navigate("/tasks")}>
          <h3>Tasks</h3>
          <p>Create and track action items for organization workflows.</p>
        </article>
        <article onClick={() => navigate("/scheduler")}>
          <h3>Scheduler</h3>
          <p>Review meetings and plan team schedules.</p>
        </article>
      </div>
    </div>
  );
}
