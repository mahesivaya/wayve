import type {
  ChatChannel,
  ChatConversationSummary,
  ChatUser,
} from "../../api/chat";
import type { Conversation } from "../types";
import { relativeTime } from "../utils";
import { PersonIcon } from "../../icons";

type Props = {
  users: ChatUser[];
  channels: ChatChannel[];
  selectedConversation: Conversation | null;
  summary: ChatConversationSummary;
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

// "Recent" lists the conversations you're actively in — recent DMs AND the
// channels you're a member of that have activity — interleaved by last-message
// time. Unread DMs appear inline here (with their unread badge) rather than in
// a separate "Unread" group at the top.
export default function RecentConversations({
  users,
  channels,
  selectedConversation,
  summary,
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

  // Include unread DMs inline (they keep their badge in renderDm) instead of
  // hoisting them into a separate group above.
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
        </span>
        <span className="conversation-main">
          <span className="conversation-name">{r.user.email}</span>
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
