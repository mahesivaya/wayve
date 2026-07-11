import type { ChatChannel } from "../../api/chat";
import type { PresenceInfo } from "../hooks/usePresence";
import { relativeTime } from "../utils";

type Props = {
  title: string;
  selectedChannel: ChatChannel | null;
  // True when the open conversation is a 1:1 DM (drives the presence line).
  isDirect: boolean;
  // The peer's presence for a DM; null until known / not a DM.
  presence: PresenceInfo | null;
  settingsOpen: boolean;
  // Audio / video call entry points. Only rendered for 1:1 conversations
  // (the host hides them on channels by passing `null` callbacks).
  onAudioCall: (() => void) | null;
  onVideoCall: (() => void) | null;
  // Disable while we're already in a call or signaling channel is down.
  callDisabled?: boolean;
  onBack: () => void;
  onToggleSettings: () => void;
  onJoinChannel: (channel: ChatChannel) => void;
};

export default function ChatHeader({
  title,
  selectedChannel,
  isDirect,
  presence,
  settingsOpen,
  onAudioCall,
  onVideoCall,
  callDisabled,
  onBack,
  onToggleSettings,
  onJoinChannel,
}: Props) {
  const showCallButtons = !selectedChannel && (onAudioCall || onVideoCall);
  // Presence line under a DM peer's name. Unknown until the first snapshot;
  // once known, "Online" (green) or "last seen …" from the durable timestamp.
  const showPresence = isDirect && !selectedChannel && presence !== null;
  const presenceOnline = presence?.online ?? false;
  const lastSeenLabel = presence?.lastSeen ? relativeTime(presence.lastSeen) : "";

  return (
    <div className="chat-header">
      <div className="chat-header-main">
        <button
          type="button"
          className="chat-back-btn"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          ‹
        </button>
        <div className="chat-header-copy">
          <h3>{title}</h3>
          {showPresence && (
            <span className="chat-presence-line">
              <span
                className={`presence-dot ${
                  presenceOnline ? "online" : "offline"
                } presence-dot--inline`}
                aria-hidden="true"
              />
              {presenceOnline
                ? "Online"
                : lastSeenLabel
                  ? `last seen ${lastSeenLabel}`
                  : "Offline"}
            </span>
          )}
          {selectedChannel && (
            <span>
              {selectedChannel.visibility} group
              {selectedChannel.is_member
                ? ` · ${[
                    ...selectedChannel.member_emails,
                    ...(selectedChannel.invite_emails ?? []).map(
                      (email) => `${email} invited`
                    ),
                  ].join(", ")}`
                : selectedChannel.join_status === "pending"
                  ? " · request pending"
                  : " · join to read and write messages"}
            </span>
          )}
        </div>

        {showCallButtons && (
          <div className="chat-header-actions chat-header-call-actions">
            {onAudioCall && (
              <button
                type="button"
                className="chat-call-btn chat-call-btn-audio"
                onClick={onAudioCall}
                disabled={callDisabled}
                title="Audio call"
                aria-label={`Audio call ${title}`}
              >
                {/* Handset silhouette — matches the green-camcorder treatment
                    on the sibling video button, but in blue to distinguish
                    audio-only from video calls at a glance. */}
                <svg
                  className="chat-call-icon-audio"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.5 11.5 0 0 0 3.6.58 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.5 11.5 0 0 0 .58 3.6 1 1 0 0 1-.25 1l-2.23 2.2Z" />
                </svg>
              </button>
            )}
            {onVideoCall && (
              <button
                type="button"
                className="chat-call-btn chat-call-btn-video"
                onClick={onVideoCall}
                disabled={callDisabled}
                title="Video call"
                aria-label={`Video call ${title}`}
              >
                {/* Camcorder silhouette in green — narrow lens snout points
                    outward, matches the Meet/Zoom-style "start video" icon. */}
                <svg
                  className="chat-call-icon-video"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="2" y="6" width="13" height="12" rx="2.5" />
                  <path d="M16 9 L22 6 V18 L16 15 Z" />
                </svg>
              </button>
            )}
          </div>
        )}

        {selectedChannel && (
          <div className="chat-header-actions">
            {!selectedChannel.is_member && (
              <button
                type="button"
                className="channel-header-join"
                disabled={selectedChannel.join_status === "pending"}
                onClick={() => onJoinChannel(selectedChannel)}
              >
                {selectedChannel.join_status === "pending"
                  ? "Pending"
                  : selectedChannel.visibility === "public"
                    ? "Join"
                    : "Request"}
              </button>
            )}
            {selectedChannel.is_member && (
              <button
                type="button"
                className={`channel-settings-btn ${settingsOpen ? "active" : ""}`}
                onClick={onToggleSettings}
                title="Channel settings"
                aria-label="Channel settings"
              >
                ⚙
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
