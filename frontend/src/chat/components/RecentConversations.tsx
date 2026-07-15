import type {
  ChatChannel,
  ChatConversationSummary,
  ChatUser,
} from "../../api/chat";
import type { PresenceMap } from "../hooks/usePresence";
import type { Conversation } from "../types";
import { presenceNameClass, relativeTime } from "../utils";
import { PersonIcon } from "../../icons";
import PresenceDot from "./PresenceDot";

type Props = {
  users: ChatUser[];
  channels: ChatChannel[];
  selectedConversation: Conversation | null;
  summary: ChatConversationSummary;
  presence: PresenceMap;
  onSelectUser: (user: ChatUser) => void;
  onSelectChannel: (channel: ChatChannel) => void;
};

type DmRow = {
  kind: "dm";
  user: ChatUser;
  unread: number;
  lastAt: string | null;
};
type ChannelRow = { kind: "channel"; channel: ChatChannel; lastAt: string };
type RecentRow = DmRow | ChannelRow;

const ts = (v: string | null) => (v ? Date.parse(v) : 0);
const byRecency = (a: RecentRow, b: RecentRow) => ts(b.lastAt) - ts(a.lastAt);

// DMs and member channels with activity, interleaved by last-message time. Unread DMs
// stay inline with their badge rather than being hoisted into a separate group.
export default function RecentConversations({
  users,
  channels,
  selectedConversation,
  summary,
  presence,
  onSelectUser,
  onSelectChannel,
}: Props) {
  const byUser = new Map(summary.conversations.map((c) => [c.user_id, c]));
  const dmRows: DmRow[] = users.map((user) => {
    const c = byUser.get(user.id);
    return {
      kind: "dm",
      user,
      unread: c?.unread_count ?? 0,
      lastAt: c?.last_message_at ?? null,
    };
  });

  const recentDMs: RecentRow[] = dmRows.filter((r) => r.lastAt);
  const recentChannels: RecentRow[] = channels
    .filter((ch) => ch.is_member && ch.last_message_at)
    .map((ch) => ({
      kind: "channel",
      channel: ch,
      lastAt: ch.last_message_at as string,
    }));
  const recent = [...recentDMs, ...recentChannels].sort(byRecency);

  const renderDm = (r: DmRow) => {
    const active =
      selectedConversation?.type === "user" &&
      selectedConversation.user.id === r.user.id;
    const time = relativeTime(r.lastAt);
    return (
      <button
        key={`dm-${r.user.id}`}
        type="button"
        className={`conversation-item ${active ? "active" : ""}`}
        onClick={() => onSelectUser(r.user)}
      >
        <span className="conversation-icon">
          <PersonIcon size={16} />
          <PresenceDot presence={presence.get(r.user.id)} />
        </span>
        <span className="conversation-main">
          <span
            className={`conversation-name ${presenceNameClass(presence.get(r.user.id))}`}
          >
            {r.user.email}
          </span>
        </span>
        {time && <span className="conversation-time">{time}</span>}
        {r.unread > 0 && (
          <span
            className="conversation-unread-badge"
            aria-label={`${r.unread} unread`}
          >
            {r.unread > 99 ? "99+" : r.unread}
          </span>
        )}
      </button>
    );
  };

  const renderChannel = (r: ChannelRow) => {
    const active =
      selectedConversation?.type === "channel" &&
      selectedConversation.channel.id === r.channel.id;
    const time = relativeTime(r.lastAt);
    return (
      <button
        key={`ch-${r.channel.id}`}
        type="button"
        className={`conversation-item ${active ? "active" : ""}`}
        onClick={() => onSelectChannel(r.channel)}
      >
        <span className="conversation-icon">#</span>
        <span className="conversation-main">
          <span className="conversation-name">{r.channel.name}</span>
        </span>
        {time && <span className="conversation-time">{time}</span>}
      </button>
    );
  };

  const renderRow = (r: RecentRow) =>
    r.kind === "dm" ? renderDm(r) : renderChannel(r);

  if (recent.length === 0) return null;

  return (
    <>
      <div className="conversation-section-title conversation-section-title--recent">
        Recent
      </div>
      {recent.map(renderRow)}
    </>
  );
}
