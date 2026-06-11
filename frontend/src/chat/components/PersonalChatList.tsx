import type { ChatConversationSummary, ChatUser } from "../../api/chat";
import type { Conversation } from "../types";
import { relativeTime } from "../utils";

type Props = {
  users: ChatUser[];
  selectedConversation: Conversation | null;
  onSelect: (user: ChatUser) => void;
  summary: ChatConversationSummary;
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
}: Props) {
  // Index the DM summary by the other participant's id.
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

  // Top level: conversations with unread messages. Second level: the rest of
  // the recent chat history (messaged before, nothing unread). Everyone else
  // (no history) stays in a plain People directory for starting new chats.
  const unread = rows.filter((r) => r.unread > 0).sort(byRecency);
  const recent = rows.filter((r) => r.unread === 0 && r.lastAt).sort(byRecency);
  const people = rows
    .filter((r) => r.unread === 0 && !r.lastAt)
    .sort((a, b) => a.user.email.localeCompare(b.user.email));

  const renderRow = (r: Row) => {
    const active =
      selectedConversation?.type === "user" &&
      selectedConversation.user.id === r.user.id;
    const label = r.user.email;
    const time = relativeTime(r.lastAt);
    return (
      <button
        key={r.user.id}
        type="button"
        className={`conversation-item ${active ? "active" : ""}`}
        onClick={() => onSelect(r.user)}
      >
        <span className="conversation-icon">
          {label.charAt(0).toUpperCase()}
        </span>
        <span className="conversation-main">
          <span className="conversation-name">{label}</span>
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
          {unread.map(renderRow)}
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className="conversation-section-title">Recent</div>
          {recent.map(renderRow)}
        </>
      )}

      <div className="conversation-section-title">People</div>
      {people.map(renderRow)}
    </>
  );
}
