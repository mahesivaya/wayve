import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { createAdminUser, type AdminCreatedUser } from "../api/admin";
import { slugify, getEmailDomain } from "../auth/accountHome";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./organizationAdmin.css";

export default function OrganizationMembers() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");

  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [createdUsers, setCreatedUsers] = useState<AdminCreatedUser[]>([]);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [creating, setCreating] = useState(false);

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
    <div className="organization-admin-home u-page-shell">
      <div className="organization-admin-header u-panel u-flex-between">
        <div>
          <h1>Members & roles</h1>
          <p>Provision accounts inside your organization and manage role assignments.</p>
        </div>
        <Link to="/organization-home" className="u-btn-primary">
          ← Back to organization home
        </Link>
      </div>

      {canManageMembers && (
        <section className="organization-admin-create u-panel">
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
            <label className="u-form-label">
              <span className="u-form-label-text">Handle</span>
              <input
                className="u-form-control"
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

            <label className="u-form-label">
              <span className="u-form-label-text">Password</span>
              <input
                className="u-form-control"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 6 characters"
                minLength={6}
                required
              />
            </label>

            <button className="u-btn-primary" type="submit" disabled={creating}>
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
    </div>
  );
}
