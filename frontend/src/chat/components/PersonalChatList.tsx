import type { ChatConversationSummary, ChatUser } from "../../api/chat";
import type { PresenceMap } from "../hooks/usePresence";
import type { Conversation } from "../types";
import { presenceNameClass, relativeTime } from "../utils";
import { PersonIcon } from "../../icons";
import PresenceDot from "./PresenceDot";
import ConversationRow from "./ConversationRow";

type Props = {
  users: ChatUser[];
  selectedConversation: Conversation | null;
  onSelect: (user: ChatUser) => void;
  summary: ChatConversationSummary;
  presence: PresenceMap;
  /**
   * Which half of the DM list to render: `"recent"` is the active conversations,
   * `"people"` everyone you have a DM with, below the channels.
   */
  section: "recent" | "people";
};

type Row = {
  user: ChatUser;
  unread: number;
  lastAt: string | null;
};

export default function PersonalChatList({
  users,
  selectedConversation,
  onSelect,
  summary,
  presence,
  section,
}: Props) {
  const byUser = new Map(summary.conversations.map((c) => [c.user_id, c]));

  const rows: Row[] = users.map((user) => {
    const c = byUser.get(user.id);
    return {
      user,
      unread: c?.unread_count ?? 0,
      lastAt: c?.last_message_at ?? null,
    };
  });

  const byRecency = (a: Row, b: Row) =>
    (b.lastAt ? Date.parse(b.lastAt) : 0) -
    (a.lastAt ? Date.parse(a.lastAt) : 0);

  const unread = rows.filter((r) => r.unread > 0).sort(byRecency);
  const recent = rows.filter((r) => r.unread === 0 && r.lastAt).sort(byRecency);
  // The DM list: only people you have a conversation with, by name. The person
  // open on screen stays listed too, so a chat just started from "New chat"
  // doesn't vanish before its first message.
  const openUserId =
    selectedConversation?.type === "user" ? selectedConversation.user.id : null;
  const people = rows
    .filter((r) => byUser.has(r.user.id) || r.user.id === openUserId)
    .sort((a, b) => a.user.email.localeCompare(b.user.email));

  // `meta` (relative time and unread badge) explains why a Recent/Unread row is
  // there, so the plain directory row omits it.
  const renderRow = (r: Row, meta = true) => {
    const active =
      selectedConversation?.type === "user" &&
      selectedConversation.user.id === r.user.id;
    const label = r.user.email;
    const time = relativeTime(r.lastAt);
    return (
      <ConversationRow key={r.user.id} label={r.user.email}>
        <button
          type="button"
          className={`conversation-item ${active ? "active" : ""}`}
          onClick={() => onSelect(r.user)}
        >
          <span className="conversation-icon">
            <PersonIcon size={16} />
            <PresenceDot presence={presence.get(r.user.id)} />
          </span>
          <span className="conversation-main">
            <span
              className={`conversation-name ${presenceNameClass(presence.get(r.user.id))}`}
            >
              {label}
            </span>
          </span>
          {meta && time && <span className="conversation-time">{time}</span>}
          {meta && r.unread > 0 && (
            <span
              className="conversation-unread-badge"
              aria-label={`${r.unread} unread`}
            >
              {r.unread > 99 ? "99+" : r.unread}
            </span>
          )}
        </button>
      </ConversationRow>
    );
  };

  // The "DMs" header is rendered by ConversationSidebar.
  if (section === "people") {
    if (people.length === 0) {
      return <p className="conversation-empty">No direct messages yet.</p>;
    }
    return <>{people.map((r) => renderRow(r, false))}</>;
  }

  return (
    <>
      {unread.length > 0 && (
        <>
          <div className="conversation-section-title conversation-section-title--unread">
            <span>Unread</span>
            <span
              className="conversation-unread-total"
              aria-label="total unread"
            >
              {summary.total_unread > 99 ? "99+" : summary.total_unread}
            </span>
          </div>
          {unread.map((r) => renderRow(r))}
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className="conversation-section-title conversation-section-title--recent">
            Recent
          </div>
          {recent.map((r) => renderRow(r))}
        </>
      )}
    </>
  );
}
