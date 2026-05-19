import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
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
} from "../auth/permissions";
import "./membersPanel.css";

// Members & Roles management panel, shared by the organization and platform
// admin homes. Listing requires `members:read`; the role <select> only appears
// for members the viewer is actually allowed to modify (see canModifyMember).
type Props =
  | { scope: "platform" }
  | { scope: "organization"; organizationId: number };

export default function MembersRolesPanel(props: Props) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const permissions = user?.permissions ?? [];
  const canRead = hasPermission(user, "members:read");
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

  // Listing is gated on members:read — viewers without it never see the panel.
  if (!canRead) return null;

  return (
    <section className="rbac-members-panel">
      <div className="rbac-members-header">
        <h2>Members &amp; Roles</h2>
        <p>
          {canChangeRoles
            ? "Assign roles to members. Your role determines which roles you can grant."
            : "Roles for the members of this workspace."}
        </p>
      </div>

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
            return (
              <div className="rbac-members-row" key={member.user_id}>
                <div className="rbac-members-identity">
                  <strong>{member.username || member.email}</strong>
                  <span>{member.email}</span>
                </div>
                {editable ? (
                  <select
                    value={normalizeRole(member.role)}
                    disabled={savingId === member.user_id}
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
