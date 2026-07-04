import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { rewrapMemberForPasswordReset } from "../orgKeys/ownerImpersonate";
import { resetMemberPassword } from "../orgKeys/api";
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
import MembersTree from "./MembersTree";
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
  // Members are shown as an org-chart tree by default (click a node for
  // details); "List" switches to the management rows (role change / delete).
  const [view, setView] = useState<"tree" | "list">("tree");

  // Password-reset modal state. Modal opens with a target member; the
  // form captures the new temp password, computes a fresh login wrap in
  // the browser using the org master key, and POSTs both. Success closes
  // the modal and surfaces the new password so the admin can share it.
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetDone, setResetDone] = useState<{
    email: string;
    tempPassword: string;
  } | null>(null);

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

  // Detail-page path for a member, routed by scope. Used by both the list rows
  // and the tree nodes. Platform URLs use the member's username (canonical),
  // falling back to the numeric id when a member has no username.
  const memberHref = (m: Pick<Member, "user_id" | "username">) => {
    if (props.scope === "platform") {
      const slug = m.username?.trim() ? m.username.trim() : String(m.user_id);
      return `/platform/members/${encodeURIComponent(slug)}`;
    }
    return `/organization/members/${m.user_id}`;
  };

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
          setError(
            err instanceof Error ? err.message : "Failed to load members"
          );
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
  const submitResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetTarget || props.scope !== "organization" || !user) return;
    if (resetPassword.length < 8) {
      setResetError("Temp password must be at least 8 characters.");
      return;
    }
    setResetBusy(true);
    setResetError("");
    try {
      const newWrap = await rewrapMemberForPasswordReset(
        props.organizationId,
        user.id,
        resetTarget.user_id,
        resetPassword
      );
      await resetMemberPassword(props.organizationId, resetTarget.user_id, {
        new_password: resetPassword,
        new_login_wrap: {
          iv: newWrap.iv,
          ct: newWrap.ct,
          salt: newWrap.salt,
          iterations: newWrap.iterations,
        },
      });
      setResetDone({ email: resetTarget.email, tempPassword: resetPassword });
      setResetTarget(null);
      setResetPassword("");
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetBusy(false);
    }
  };

  const deleteMember = async (member: Member) => {
    const label = member.username || member.email;
    if (
      !window.confirm(
        `Permanently delete ${label}? This removes their account, messages, files, and channel memberships. This cannot be undone.`
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
        account_type:
          props.scope === "platform" ? "platform_admin" : "organization",
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
      setCreateError(
        err instanceof Error ? err.message : "Failed to create user"
      );
    } finally {
      setCreateBusy(false);
    }
  };

  // Listing is gated on members:read — viewers without it never see the panel.
  if (!canRead) return null;

  return (
    <section className="rbac-members-panel">
      {/* Reset-password "done" banner — surfaces the new temp password
          once so the admin can share it out-of-band. Dismissable. */}
      {resetDone && (
        <div
          style={{
            margin: "0 0 16px",
            padding: 12,
            border: "1px solid #fde68a",
            background: "#fef3c7",
            borderRadius: 8,
          }}
        >
          <strong>Password reset for {resetDone.email}.</strong>
          <p style={{ margin: "4px 0" }}>
            New temp password:{" "}
            <code
              style={{
                padding: "2px 6px",
                background: "#fff",
                border: "1px solid #fcd34d",
                borderRadius: 4,
              }}
            >
              {resetDone.tempPassword}
            </code>
          </p>
          <p style={{ margin: "4px 0", fontSize: 12, color: "#92400e" }}>
            Share this with the member out-of-band (Slack, SMS, in person). They
            keep all their existing notes / files / messages — only the password
            changed.
          </p>
          <button
            type="button"
            onClick={() => setResetDone(null)}
            style={{
              marginTop: 6,
              padding: "4px 12px",
              border: "1px solid #d97706",
              background: "transparent",
              color: "#92400e",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Reset-password modal */}
      {resetTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => {
            if (!resetBusy) {
              setResetTarget(null);
              setResetError("");
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              padding: 24,
              borderRadius: 8,
              maxWidth: 480,
              width: "90%",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              Reset password for {resetTarget.email}
            </h3>
            <p style={{ color: "#6b7280", fontSize: 14 }}>
              Your browser will re-wrap this member's private key under the new
              password using the org master key. The member keeps all their
              existing notes / files / messages — they just log in with the new
              password. Share the new password out-of-band.
            </p>
            <form onSubmit={submitResetPassword}>
              <label style={{ display: "block", margin: "12px 0" }}>
                <span style={{ display: "block", marginBottom: 4 }}>
                  New temporary password
                </span>
                <input
                  type="text"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  autoFocus
                  required
                  minLength={8}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    color: "#111827",
                  }}
                />
              </label>
              {resetError && (
                <div style={{ margin: "8px 0" }}>
                  <p style={{ color: "#b91c1c", margin: 0 }}>{resetError}</p>
                  {/^.*org master key not loaded/i.test(resetError) && (
                    <Link
                      to="/organization/recovery-key"
                      style={{
                        display: "inline-block",
                        marginTop: 10,
                        padding: "8px 16px",
                        background: "#2563eb",
                        color: "white",
                        borderRadius: 4,
                        textDecoration: "none",
                        fontWeight: 600,
                      }}
                    >
                      Enter recovery mnemonic →
                    </Link>
                  )}
                </div>
              )}
              <div
                style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
              >
                <button
                  type="button"
                  disabled={resetBusy}
                  onClick={() => {
                    setResetTarget(null);
                    setResetError("");
                  }}
                  style={{ padding: "8px 16px" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetBusy}
                  style={{
                    padding: "8px 16px",
                    background: "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                  }}
                >
                  {resetBusy ? "Resetting…" : "Reset password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
          {/* The organization page has its own enhanced "Create account" form
              (with email + role), so this inline creator is platform-only —
              where it is the only way to create users. */}
          {props.scope === "platform" && canManage && !createOpen && (
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
            <strong>{lastCreated.email}</strong> created as{" "}
            {ROLE_LABELS[normalizeRole(lastCreated.role)]}.
          </div>
          <div className="rbac-create-password">
            Temporary password (shown once):{" "}
            <code>{lastCreated.tempPassword}</code>
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

      {props.scope === "platform" && createOpen && (
        <form
          className="rbac-create-form"
          onSubmit={(e) => void submitCreate(e)}
        >
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
        <>
          <div className="rbac-view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={view === "tree" ? "active" : ""}
              onClick={() => setView("tree")}
            >
              Tree
            </button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
            >
              List
            </button>
          </div>
          {view === "tree" ? (
            <MembersTree members={members} memberHref={memberHref} />
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
                      <Link
                        to={memberHref(member)}
                        className="rbac-members-name-link"
                      >
                        {member.username || member.email}
                      </Link>
                      <span>{member.email}</span>
                    </div>
                    <div className="rbac-members-actions">
                      {editable ? (
                        <select
                          value={normalizeRole(member.role)}
                          disabled={
                            savingId === member.user_id ||
                            deletingId === member.user_id
                          }
                          onChange={(event) =>
                            changeRole(member, event.target.value)
                          }
                        >
                          {roleOptions.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="rbac-members-role">
                          {member.role_label}
                        </span>
                      )}
                      {/* Org master-key flows: only meaningful in organization
                      scope, and only for users holding org_keys:use_master
                      (owner / super_admin / admin). Hidden for the caller's
                      own row — recovering your own data is meaningless. */}
                      {props.scope === "organization" &&
                        hasPermission(user, "org_keys:use_master") &&
                        member.user_id !== user?.id && (
                          <>
                            <Link
                              to={`/organization/members/${member.user_id}/impersonate`}
                              className="rbac-delete-btn"
                              style={{
                                textDecoration: "none",
                                color: "#2563eb",
                                borderColor: "#bfdbfe",
                              }}
                              title="Recover this member's data using the org master key"
                            >
                              Recover data
                            </Link>
                            {/* Reset password — only for non-key-holder rows.
                            Key-holder rows (owner / super_admin / admin)
                            are refused server-side anyway; hiding the
                            button avoids a wasted modal. */}
                            {!["owner", "super_admin", "admin"].includes(
                              normalizeRole(member.role)
                            ) && (
                              <button
                                type="button"
                                className="rbac-delete-btn"
                                style={{
                                  color: "#a16207",
                                  borderColor: "#fde68a",
                                }}
                                onClick={() => {
                                  setResetTarget(member);
                                  setResetError("");
                                  setResetPassword("");
                                }}
                                title="Reset this member's password — they'll keep all their data"
                              >
                                Reset password
                              </button>
                            )}
                          </>
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
                          {deletingId === member.user_id
                            ? "Deleting…"
                            : "Delete"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
