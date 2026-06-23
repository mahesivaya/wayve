import type { ChatChannel } from "../../api/chat";
import type { ChannelRole, ChannelVisibility } from "../types";
import { roleFromValue } from "../utils";

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
  onSaveVisibility: () => void;
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

  return (
    <aside className="channel-settings-panel" aria-label="Channel settings">
      <div className="channel-settings-section">
        <span className="channel-settings-label">Subject</span>
        {isAdmin ? (
          <div className="channel-edit-row">
            <input
              value={subjectDraft}
              onChange={(e) => onSubjectDraftChange(e.target.value)}
              aria-label="Channel subject"
            />
            <button type="button" onClick={onSaveSubject}>
              Save
            </button>
          </div>
        ) : (
          <strong>{channel.name}</strong>
        )}
      </div>

      <div className="channel-settings-section">
        <span className="channel-settings-label">Visibility</span>
        {isAdmin ? (
          <div className="channel-edit-row">
            <select
              value={visibilityDraft}
              onChange={(e) =>
                onVisibilityDraftChange(e.target.value as ChannelVisibility)
              }
              aria-label="Channel visibility"
            >
              <option value="private">Private group</option>
              <option value="public">Public group</option>
            </select>
            <button type="button" onClick={onSaveVisibility}>
              Save
            </button>
          </div>
        ) : (
          <strong>{channel.visibility}</strong>
        )}
      </div>

      <MemberSection
        title="Admins"
        emptyText="No admins listed"
        people={admins}
        canDelete={isAdmin}
        onDeleteUser={onDeleteUser}
      />

      <MemberSection
        title="All users"
        emptyText="No users listed"
        people={users}
        canDelete={isAdmin}
        onDeleteUser={onDeleteUser}
      />

      {isAdmin && (
        <div className="channel-settings-section">
          <span className="channel-settings-label">Add users</span>
          <label className="channel-field">
            <span>Role</span>
            <select
              value={addUserRole}
              onChange={(e) =>
                onAddUserRoleChange(roleFromValue(e.target.value))
              }
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="channel-field">
            <span>Emails</span>
            <textarea
              value={addUserEmails}
              onChange={(e) => onAddUserEmailsChange(e.target.value)}
              placeholder="alex@example.com, priya@example.com"
            />
          </label>
          <button
            type="button"
            className="channel-settings-primary"
            onClick={onAddUsers}
          >
            Add
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="channel-settings-section">
          <span className="channel-settings-label">Join requests</span>
          <div className="channel-settings-list">
            {pendingRequests.length ? (
              pendingRequests.map((request) => (
                <div key={request.user_id} className="channel-person-row">
                  <span className="channel-person">{request.email}</span>
                  <button
                    type="button"
                    onClick={() => onApproveJoinRequest(request.user_id)}
                  >
                    Approve
                  </button>
                </div>
              ))
            ) : (
              <span className="channel-empty">No pending requests</span>
            )}
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="channel-settings-note">
          Only admins can change the subject, add users, or delete users.
        </div>
      )}

      {error && <div className="channel-error">{error}</div>}
    </aside>
  );
}

type MemberSectionProps = {
  title: string;
  emptyText: string;
  people: string[];
  canDelete: boolean;
  onDeleteUser: (email: string) => void;
};

function MemberSection({
  title,
  emptyText,
  people,
  canDelete,
  onDeleteUser,
}: MemberSectionProps) {
  return (
    <div className="channel-settings-section">
      <span className="channel-settings-label">{title}</span>
      <div className="channel-settings-list">
        {people.length ? (
          people.map((email) => (
            <div key={email} className="channel-person-row">
              <span className="channel-person">{email}</span>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => onDeleteUser(email)}
                  aria-label={`Delete ${email}`}
                >
                  Delete
                </button>
              )}
            </div>
          ))
        ) : (
          <span className="channel-empty">{emptyText}</span>
        )}
      </div>
    </div>
  );
}
