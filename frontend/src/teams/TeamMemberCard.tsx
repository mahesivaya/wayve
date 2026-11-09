import { useEffect } from "react";
import ContactAvatar from "../shared/ContactAvatar";
import { formatJoined } from "./formatJoined";
import type { Member } from "./TeamMembersTable";

// Details of the member picked in the team roster, beside the list. Shows the
// roster row itself: a team member is a free-form entry (team_members has no
// link to a user account), so there is no account profile to load for one.
export default function TeamMemberCard({
  member,
  onClose,
}: {
  member: Member;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const joined = formatJoined(member.joinedAt);

  return (
    <aside
      className="team-member-card u-panel"
      aria-label={`Details for ${member.name}`}
    >
      <button
        type="button"
        className="team-member-card-close"
        onClick={onClose}
        aria-label="Close details"
        data-tooltip="Close"
        data-tooltip-align="right"
      >
        ✕
      </button>

      <div className="team-member-card-head">
        <ContactAvatar
          label={member.name}
          className="team-member-card-avatar"
        />
        <h3 className="team-member-card-name">{member.name}</h3>
      </div>

      <dl className="team-member-card-rows">
        {member.email && (
          <div className="team-member-card-row">
            <dt>Email</dt>
            <dd>{member.email}</dd>
          </div>
        )}
        <div className="team-member-card-row">
          <dt>Role</dt>
          <dd>{member.role}</dd>
        </div>
        <div className="team-member-card-row">
          <dt>Joined</dt>
          <dd>{joined || "—"}</dd>
        </div>
        <div className="team-member-card-row">
          <dt>Teams</dt>
          <dd>{member.teams.length > 0 ? member.teams.join(", ") : "—"}</dd>
        </div>
      </dl>
    </aside>
  );
}
