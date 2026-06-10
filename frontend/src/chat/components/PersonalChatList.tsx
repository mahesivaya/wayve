import type { ChatUser } from "../../api/chat";
import type { Conversation } from "../types";

type Props = {
  users: ChatUser[];
  selectedConversation: Conversation | null;
  onSelect: (user: ChatUser) => void;
};

export default function PersonalChatList({
  users,
  selectedConversation,
  onSelect,
}: Props) {
  return (
    <>
      <div className="conversation-section-title">People</div>
      {users.map((u) => {
        // Show the full email — it's unique per user, so two people with the
        // same local-part on different domains (alice@acme.com vs
        // alice@gmail.com) stay distinguishable instead of both showing "alice".
        const name = u.email;
        return (
          <button
            key={u.id}
            type="button"
            className={`conversation-item ${
              selectedConversation?.type === "user" &&
              selectedConversation.user.id === u.id
                ? "active"
                : ""
            }`}
            onClick={() => onSelect(u)}
          >
            <span className="conversation-icon">
              {name.charAt(0).toUpperCase()}
            </span>
            <span className="conversation-main">
              <span className="conversation-name">{name}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
