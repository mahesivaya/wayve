import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/useAuth";
import {
  adminCreateUser,
  adminDeleteUser,
  listOrganizationMembers,
  listPlatformMembers,
  updateOrganizationMemberRole,
  updatePlatformMemberRole,
  type Member,
} from "../api/rbac";
import {
  assignableRoles,
  canModifyMember,
  hasPermission,
  normalizeRole,
  ROLE_LABELS,
  type Role,
} from "../auth/permissions";
import "./membersPanel.css";

// Roles offered in the inline "Create new user" form. Intentionally a tight
// subset of the 9-role catalog — admins typically provision these and only
// promote to owner/super_admin/admin/billing through the existing per-row
// role change.
const CREATE_ROLES: Role[] = ["guest", "developer", "member", "support"];

// Members & Roles management panel, shared by the organization and platform
// admin homes. Listing requires `members:read`; the role <select> only appears
// for members the viewer is actually allowed to modify (see canModifyMember).
// The "Create new user" form requires `members:manage`.
type Props =
  | { scope: "platform" }
  | { scope: "organization"; organizationId: number };

export default function MembersRolesPanel(props: Props) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Create-user inline form state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createRole, setCreateRole] = useState<Role>("member");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  // The plaintext password is returned by the backend exactly once. Hold it
  // in component state until the admin dismisses the banner so they can copy
  // and share it. Refresh/navigation away loses it (intentionally).
  const [lastCreated, setLastCreated] = useState<{
    email: string;
    tempPassword: string;
    role: string;
  } | null>(null);

  const permissions = user?.permissions ?? [];
  const canRead = hasPermission(user, "members:read");
  const canManage = hasPermission(user, "members:manage");
  const roleOptions = assignableRoles(permissions);
  const canChangeRoles = roleOptions.length > 0;
  const organizationId =
    props.scope === "organization" ? props.organizationId : null;

  useEffect(() => {
    // Without members:read the panel renders nothing (see the guard at the end
    // of the component), so there is no loading state to reset here.
    if (!canRead) return;

    // `loading` starts true and is only ever cleared in the async finally
    // below — no synchronous setState in the effect body.
    let alive = true;
    const request =
      props.scope === "platform" || organizationId == null
        ? listPlatformMembers()
        : listOrganizationMembers(organizationId);

    request
      .then((items) => {
        if (alive) setMembers(items);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "Failed to load members");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [canRead, props.scope, organizationId]);

  const changeRole = async (member: Member, nextRole: string) => {
    if (nextRole === member.role) return;
    setSavingId(member.user_id);
    setError("");
    try {
      const updated =
        props.scope === "platform"
          ? await updatePlatformMemberRole(member.user_id, nextRole)
          : await updateOrganizationMemberRole(
              props.organizationId,
              member.user_id,
              nextRole
            );
      setMembers((prev) =>
        prev.map((item) =>
          item.user_id === updated.user_id
            ? { ...item, role: updated.role, role_label: updated.role_label }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setSavingId(null);
    }
  };

  // Hard-delete with a native confirm prompt. Server-side gates handle the
  // last-owner / role-management / cross-scope edge cases; this just keeps
  // the user from accidentally clicking through.
  const deleteMember = async (member: Member) => {
    const label = member.username || member.email;
    if (
      !window.confirm(
        `Permanently delete ${label}? This removes their account, messages, files, and channel memberships. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(member.user_id);
    setError("");
    try {
      await adminDeleteUser(member.user_id);
      setMembers((prev) => prev.filter((m) => m.user_id !== member.user_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = createEmail.trim();
    if (!email) {
      setCreateError("Email is required");
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const created = await adminCreateUser({
        email,
        role: createRole,
        account_type: props.scope === "platform" ? "platform_admin" : "organization",
      });
      setMembers((prev) => [
        ...prev,
        {
          user_id: created.id,
          email: created.email,
          username: created.username,
          role: created.role,
          role_label: ROLE_LABELS[normalizeRole(created.role)],
        },
      ]);
      if (created.temp_password) {
        setLastCreated({
          email: created.email,
          tempPassword: created.temp_password,
          role: created.role,
        });
      }
      setCreateEmail("");
      setCreateRole("member");
      setCreateOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreateBusy(false);
    }
  };

  // Listing is gated on members:read — viewers without it never see the panel.
  if (!canRead) return null;

  return (
    <section className="rbac-members-panel">
      <div className="rbac-members-header">
        <div className="rbac-members-title-row">
          <div>
            <h2>Members &amp; Roles</h2>
            <p>
              {canChangeRoles
                ? "Assign roles to members. Your role determines which roles you can grant."
                : "Roles for the members of this workspace."}
            </p>
          </div>
          {canManage && !createOpen && (
            <button
              type="button"
              className="rbac-create-btn"
              onClick={() => {
                setCreateError("");
                setCreateOpen(true);
              }}
            >
              + Create new user
            </button>
          )}
        </div>
      </div>

      {lastCreated && (
        <div className="rbac-create-result" role="alert">
          <div>
            <strong>{lastCreated.email}</strong> created as {ROLE_LABELS[normalizeRole(lastCreated.role)]}.
          </div>
          <div className="rbac-create-password">
            Temporary password (shown once): <code>{lastCreated.tempPassword}</code>
            <button
              type="button"
              className="rbac-create-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(lastCreated.tempPassword);
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="rbac-create-dismiss"
              onClick={() => setLastCreated(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {createOpen && (
        <form className="rbac-create-form" onSubmit={(e) => void submitCreate(e)}>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              placeholder={
                props.scope === "platform"
                  ? "newuser@platform.com"
                  : "newuser@yourcompany.com"
              }
              autoFocus
              required
            />
          </label>
          <label>
            <span>Role</span>
            <select
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value as Role)}
            >
              {CREATE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
          {createError && <p className="rbac-create-error">{createError}</p>}
          <div className="rbac-create-actions">
            <button type="submit" disabled={createBusy}>
              {createBusy ? "Creating…" : "Create user"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setCreateOpen(false);
                setCreateError("");
                setCreateEmail("");
                setCreateRole("member");
              }}
              disabled={createBusy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <div className="rbac-members-error">{error}</div>}

      {loading ? (
        <div className="rbac-members-empty">Loading members…</div>
      ) : members.length === 0 ? (
        <div className="rbac-members-empty">No members found.</div>
      ) : (
        <div className="rbac-members-list">
          {members.map((member) => {
            const editable =
              canChangeRoles && canModifyMember(permissions, member.role);
            // Delete shares the same role-management predicate as role
            // changes, plus the actor must not be deleting themselves and
            // must still hold members:manage. Server-side enforces all three
            // again — this is only the UI gate.
            const canDelete =
              canManage &&
              canModifyMember(permissions, member.role) &&
              member.user_id !== user?.id;
            return (
              <div className="rbac-members-row" key={member.user_id}>
                <div className="rbac-members-identity">
                  <strong>{member.username || member.email}</strong>
                  <span>{member.email}</span>
                </div>
                <div className="rbac-members-actions">
                  {editable ? (
                    <select
                      value={normalizeRole(member.role)}
                      disabled={savingId === member.user_id || deletingId === member.user_id}
                      onChange={(event) => changeRole(member, event.target.value)}
                    >
                      {roleOptions.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="rbac-members-role">{member.role_label}</span>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      className="rbac-delete-btn"
                      disabled={deletingId === member.user_id}
                      onClick={() => void deleteMember(member)}
                      title="Delete account"
                      aria-label={`Delete ${member.email}`}
                    >
                      {deletingId === member.user_id ? "Deleting…" : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
