import { useState } from "react";
import type { ChatUser } from "../../api/chat";
import { NewChatIcon } from "../../icons";
import { useStartChatLookup } from "../hooks/useStartChatLookup";

type Props = {
  myUserId: number;
  users: ChatUser[];
  onFound: (user: ChatUser) => void;
  onBack: () => void;
};

// The page "New chat" opens in the main chat area: a "To:" field for an email
// or username. Once the person is found, their conversation opens with the
// composer ready for the first message.
export default function NewConversation({
  myUserId,
  users,
  onFound,
  onBack,
}: Props) {
  const [query, setQuery] = useState("");
  const { find, error, setError, busy } = useStartChatLookup(myUserId, users);

  const submit = async () => {
    const found = await find(query);
    if (found) onFound(found);
  };

  return (
    <div className="new-conversation">
      <div className="chat-header new-conversation-to">
        <button
          type="button"
          className="chat-back-btn"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          ‹
        </button>
        <label className="new-conversation-field">
          <span>To:</span>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (error) setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onBack();
            }}
            placeholder="Enter email or username"
            aria-label="Email or username"
            disabled={busy}
            autoFocus
          />
        </label>
        <button
          type="button"
          className="new-conversation-go"
          onClick={() => void submit()}
          disabled={busy || !query.trim()}
        >
          {busy ? "Looking up…" : "Start chat"}
        </button>
      </div>

      {error && (
        <div className="new-conversation-error" role="alert">
          {error}
        </div>
      )}

      <div className="new-conversation-empty">
        <span className="new-conversation-art" aria-hidden="true">
          <NewChatIcon size={56} />
        </span>
        <h3>You're starting a new conversation</h3>
        <p>
          Enter an email or username above and press Enter. Then type your first
          message below.
        </p>
      </div>
    </div>
  );
}
