import type { ChatChannel } from "../../api/chat";
import type { ChannelRole, ChannelVisibility } from "../types";

type JoinRequest = NonNullable<ChatChannel["pending_join_requests"]>[number];

type Props = {
  channel: ChatChannel;
  isAdmin: boolean;
  admins: string[];
  users: string[];
  subjectDraft: string;
  visibilityDraft: ChannelVisibility;
  addUserRole: ChannelRole;
  addUserEmails: string;
  error: string;
  onSubjectDraftChange: (value: string) => void;
  onVisibilityDraftChange: (value: ChannelVisibility) => void;
  onAddUserRoleChange: (value: ChannelRole) => void;
  onAddUserEmailsChange: (value: string) => void;
  onSaveSubject: () => void;
  // Optional value lets the Privacy radio save the just-picked option without
  // waiting for the draft state to flush.
  onSaveVisibility: (value?: ChannelVisibility) => void;
  onDeleteUser: (email: string) => void;
  onAddUsers: () => void;
  onApproveJoinRequest: (userId: number) => void;
};

export default function ChannelSettingsPanel({
  channel,
  isAdmin,
  admins,
  users,
  subjectDraft,
  visibilityDraft,
  addUserRole,
  addUserEmails,
  error,
  onSubjectDraftChange,
  onVisibilityDraftChange,
  onAddUserRoleChange,
  onAddUserEmailsChange,
  onSaveSubject,
  onSaveVisibility,
  onDeleteUser,
  onAddUsers,
  onApproveJoinRequest,
}: Props) {
  const pendingRequests: JoinRequest[] = channel.pending_join_requests ?? [];

  // `admins` is a subset of `users`, since the backend's member_emails already
  // includes admins, so tagging while iterating `users` lists each person once.
  const adminSet = new Set(admins);
  const members = users.map((email) => ({
    email,
    role: adminSet.has(email) ? "Admin" : "Member",
    invited: email.endsWith(" invited"),
  }));

  const setVisibility = (value: ChannelVisibility) => {
    onVisibilityDraftChange(value);
    onSaveVisibility(value);
  };

  return (
    <aside className="channel-settings-panel" aria-label="Channel settings">
      {/* Name — auto-saves on blur / Enter, no button. */}
      <div className="channel-settings-section">
        <span className="channel-settings-label">Name</span>
        {isAdmin ? (
          <input
            className="channel-settings-input"
            value={subjectDraft}
            onChange={(e) => onSubjectDraftChange(e.target.value)}
            onBlur={onSaveSubject}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            aria-label="Channel name"
          />
        ) : (
          <strong>{channel.name}</strong>
        )}
      </div>

      {/* Privacy — a two-option radio, saved on change. */}
      <div className="channel-settings-section">
        <span className="channel-settings-label">Privacy</span>
        {isAdmin ? (
          <div className="channel-radio-group" role="radiogroup" aria-label="Privacy">
            <label className="channel-radio">
              <input
                type="radio"
                name="channel-privacy"
                checked={visibilityDraft === "private"}
                onChange={() => setVisibility("private")}
              />
              <span className="channel-radio-copy">
                <span className="channel-radio-title">Private</span>
                <span className="channel-radio-hint">Invite only</span>
              </span>
            </label>
            <label className="channel-radio">
              <input
                type="radio"
                name="channel-privacy"
                checked={visibilityDraft === "public"}
                onChange={() => setVisibility("public")}
              />
              <span className="channel-radio-copy">
                <span className="channel-radio-title">Public</span>
                <span className="channel-radio-hint">
                  Anyone in your org can join
                </span>
              </span>
            </label>
          </div>
        ) : (
          <strong>{channel.visibility === "public" ? "Public" : "Private"}</strong>
        )}
      </div>

      {/* Members — single list; admins tagged, everyone else "Member". */}
      <div className="channel-settings-section">
        <span className="channel-settings-label">
          Members · {members.length}
        </span>
        <div className="channel-settings-list">
          {members.length ? (
            members.map((member) => (
              <div key={member.email} className="channel-member-row">
                <span className="channel-member-name">
                  {member.invited
                    ? member.email.replace(" invited", "")
                    : member.email}
                  {member.invited && (
                    <span className="channel-member-invited">invited</span>
                  )}
                </span>
                <span
                  className={`channel-role-tag ${
                    member.role === "Admin" ? "channel-role-tag--admin" : ""
                  }`}
                >
                  {member.role}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    className="channel-member-remove"
                    onClick={() => onDeleteUser(member.email)}
                    aria-label={`Remove ${member.email}`}
                    title={`Remove ${member.email}`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))
          ) : (
            <span className="channel-empty">No members yet</span>
          )}
        </div>
      </div>

      {/* Invite people — one email field; role demoted to a compact toggle. */}
      {isAdmin && (
        <div className="channel-settings-section">
          <span className="channel-settings-label">Invite people</span>
          <div className="channel-invite-row">
            <input
              className="channel-settings-input"
              value={addUserEmails}
              onChange={(e) => onAddUserEmailsChange(e.target.value)}
              placeholder="email, email…"
              aria-label="Emails to invite"
            />
            <button
              type="button"
              className="channel-settings-primary"
              onClick={onAddUsers}
            >
              Add
            </button>
          </div>
          <div
            className="channel-invite-role"
            role="radiogroup"
            aria-label="Invite as"
          >
            <span className="channel-invite-role-label">Add as</span>
            <label className="channel-radio channel-radio--inline">
              <input
                type="radio"
                name="channel-invite-role"
                checked={addUserRole === "user"}
                onChange={() => onAddUserRoleChange("user")}
              />
              Member
            </label>
            <label className="channel-radio channel-radio--inline">
              <input
                type="radio"
                name="channel-invite-role"
                checked={addUserRole === "admin"}
                onChange={() => onAddUserRoleChange("admin")}
              />
              Admin
            </label>
          </div>
        </div>
      )}

      {/* Requests — only when there are pending joins. */}
      {isAdmin && pendingRequests.length > 0 && (
        <div className="channel-settings-section">
          <span className="channel-settings-label">
            Requests · {pendingRequests.length}
          </span>
          <div className="channel-settings-list">
            {pendingRequests.map((request) => (
              <div key={request.user_id} className="channel-member-row">
                <span className="channel-member-name">{request.email}</span>
                <button
                  type="button"
                  className="channel-settings-primary channel-settings-primary--sm"
                  onClick={() => onApproveJoinRequest(request.user_id)}
                >
                  Approve
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="channel-settings-note">
          Only admins can change the name, privacy, or members.
        </div>
      )}

      {error && <div className="channel-error">{error}</div>}
    </aside>
  );
}
