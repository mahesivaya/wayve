import { useEffect, useState } from "react";
import {
  DM_FILES_PAGE,
  getDmFiles,
  getPeerProfile,
  type ChatAttachmentMeta,
  type ChatMessage,
  type ChatUser,
  type PeerProfile,
} from "../../api/chat";
import { getApiBase } from "../../config/env";
import { avatarColor, avatarInitial } from "../../shared/avatar";
import { fmtDate } from "../../utils/datetime";
import { logger } from "../../utils/logger";
import { decryptChatMessages } from "../e2ee";
import type { PresenceInfo } from "../hooks/usePresence";
import { relativeTime } from "../utils";
import { downloadAttachment, fmtSize, isImage } from "../attachmentFiles";

type Props = {
  peer: ChatUser;
  presence: PresenceInfo | null;
  currentUserId: number;
  onClose: () => void;
  // Opens one of the channels you both belong to.
  onOpenChannel: (channelId: number) => void;
};

type FileRow = { att: ChatAttachmentMeta; message: ChatMessage };

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  dnd: "Do Not Disturb",
  away: "Away",
};

function presenceLabel(presence: PresenceInfo | null): string {
  if (!presence) return "";
  if (presence.online) return STATUS_LABEL[presence.status] ?? "Active";
  const seen = relativeTime(presence.lastSeen);
  return seen ? `Offline · last seen ${seen}` : "Offline";
}

// One row per attachment, newest message first, in the order each message
// lists its files.
function toFileRows(messages: ChatMessage[]): FileRow[] {
  return messages.flatMap((message) =>
    (message.attachments ?? []).map((att) => ({ att, message }))
  );
}

// The Slack-style "about this person" pane for a direct message: who they are,
// the channels you share, and every file either of you sent in this DM.
export default function DmProfilePanel({
  peer,
  presence,
  currentUserId,
  onClose,
  onOpenChannel,
}: Props) {
  const [profile, setProfile] = useState<PeerProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [avatarFailed, setAvatarFailed] = useState(false);

  const [files, setFiles] = useState<FileRow[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState("");
  // The oldest message id loaded, for the next page; null once exhausted.
  const [cursor, setCursor] = useState<number | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    let alive = true;
    getPeerProfile(peer.id)
      .then((p) => alive && setProfile(p))
      .catch((err: unknown) => {
        if (!alive) return;
        logger.warn("peer profile load failed", err);
        setProfileError("Couldn't load profile details");
      });
    return () => {
      alive = false;
    };
  }, [peer.id]);

  // Fetch one page and append it (or replace, for the first page). State is
  // only touched after the awaits, so the mount effect can call it directly.
  const fetchPage = async (
    beforeId: number | undefined,
    alive = () => true
  ) => {
    try {
      const page = await getDmFiles(peer.id, beforeId);
      const decrypted = await decryptChatMessages(page, currentUserId);
      if (!alive()) return;
      setFiles((prev) =>
        beforeId === undefined
          ? toFileRows(decrypted)
          : [...prev, ...toFileRows(decrypted)]
      );
      const last = page[page.length - 1]?.message_id;
      setCursor(page.length === DM_FILES_PAGE && last ? last : null);
    } catch (err) {
      if (!alive()) return;
      logger.warn("dm files load failed", err);
      setFilesError("Couldn't load files");
    }
    if (alive()) setFilesLoading(false);
  };

  // The panel is keyed by peer, so this runs once per conversation.
  // Started from a timer so no state is set from the effect body itself.
  useEffect(() => {
    let alive = true;
    const handle = window.setTimeout(
      () => void fetchPage(undefined, () => alive),
      0
    );
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer.id]);

  const loadOlder = (beforeId: number) => {
    setFilesLoading(true);
    setFilesError("");
    void fetchPage(beforeId);
  };

  const download = async (row: FileRow) => {
    setDownloadError("");
    setDownloading(row.att.id);
    try {
      await downloadAttachment(row.att, row.message, currentUserId);
    } catch (err) {
      logger.warn("dm file download failed", err);
      setDownloadError(`Couldn't download ${row.att.name}`);
    } finally {
      setDownloading(null);
    }
  };

  const fullName = [profile?.first_name, profile?.last_name]
    .filter(Boolean)
    .join(" ");
  const displayName = fullName || profile?.username || peer.email;
  const status = presenceLabel(presence);

  return (
    <aside
      className="channel-settings-panel dm-profile-panel"
      aria-label={`About ${displayName}`}
    >
      <button
        type="button"
        className="channel-settings-close"
        onClick={onClose}
        aria-label="Close profile"
      >
        ×
      </button>

      <div className="channel-settings-section dm-profile-identity">
        {profile?.has_avatar && !avatarFailed ? (
          <img
            className="dm-profile-avatar"
            src={`${getApiBase()}/api/users/${peer.id}/avatar`}
            alt=""
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <span
            className="dm-profile-avatar dm-profile-avatar-initial"
            style={{ background: avatarColor(peer.email) }}
            aria-hidden="true"
          >
            {avatarInitial(displayName)}
          </span>
        )}
        <strong>{displayName}</strong>
        {profile?.username && fullName && (
          <span className="dm-profile-sub">@{profile.username}</span>
        )}
        {status && (
          <span className="dm-profile-sub">
            <span
              className={`presence-dot presence-dot--inline ${
                presence?.online
                  ? presence.status === "active"
                    ? "online"
                    : presence.status
                  : "offline"
              }`}
              aria-hidden="true"
            />
            {status}
          </span>
        )}
      </div>

      <div className="channel-settings-section">
        <span className="channel-settings-label">Contact</span>
        <a className="dm-profile-email" href={`mailto:${peer.email}`}>
          {peer.email}
        </a>
        {profile?.organization_name && (
          <span className="dm-profile-sub">{profile.organization_name}</span>
        )}
        {profile?.member_since && (
          <span className="dm-profile-sub">
            Member since {fmtDate(profile.member_since)}
          </span>
        )}
        {profileError && (
          <span className="dm-profile-error">{profileError}</span>
        )}
      </div>

      {profile && profile.shared_channels.length > 0 && (
        <div className="channel-settings-section">
          <span className="channel-settings-label">
            Shared channels ({profile.shared_channels.length})
          </span>
          <ul className="dm-profile-list">
            {profile.shared_channels.map((ch) => (
              <li key={ch.id}>
                <button
                  type="button"
                  className="dm-profile-channel"
                  onClick={() => onOpenChannel(ch.id)}
                >
                  # {ch.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="channel-settings-section">
        <span className="channel-settings-label">
          Files
          {files.length > 0 ? ` (${files.length}${cursor ? "+" : ""})` : ""}
        </span>
        {downloadError && (
          <span className="dm-profile-error">{downloadError}</span>
        )}
        {files.length > 0 && (
          <ul className="dm-profile-list">
            {files.map((row) => {
              const mine = row.message.sender_id === currentUserId;
              return (
                <li key={`${row.message.message_id}-${row.att.id}`}>
                  <button
                    type="button"
                    className="dm-profile-file"
                    onClick={() => void download(row)}
                    disabled={downloading === row.att.id}
                    data-tooltip={`Download ${row.att.name}`}
                  >
                    <span className="dm-profile-file-icon" aria-hidden="true">
                      {isImage(row.att.mime) ? "🖼️" : "📄"}
                    </span>
                    <span className="dm-profile-file-meta">
                      <span className="dm-profile-file-name">
                        {row.att.name}
                      </span>
                      <span className="dm-profile-sub">
                        {downloading === row.att.id
                          ? "Downloading…"
                          : `${fmtSize(row.att.size)} · ${
                              mine ? "You" : displayName
                            } · ${fmtDate(row.message.created_at)}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {filesLoading ? (
          <span className="dm-profile-sub">Loading files…</span>
        ) : filesError ? (
          <span className="dm-profile-error">{filesError}</span>
        ) : files.length === 0 ? (
          <span className="dm-profile-sub">No files shared yet.</span>
        ) : (
          cursor !== null && (
            <button
              type="button"
              className="dm-profile-more"
              onClick={() => loadOlder(cursor)}
            >
              Load older files
            </button>
          )
        )}
      </div>
    </aside>
  );
}
