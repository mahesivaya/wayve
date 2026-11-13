import { useState } from "react";
import type { ChatUser } from "../../api/chat";
import { useStartChatLookup } from "../hooks/useStartChatLookup";

type Props = {
  myUserId: number;
  users: ChatUser[];
  onFound: (user: ChatUser) => void;
  onCancel: () => void;
};

// "+" next to Users: start a DM by typing someone's email or username.
export default function StartChatForm({
  myUserId,
  users,
  onFound,
  onCancel,
}: Props) {
  const [query, setQuery] = useState("");
  const { find, error, busy } = useStartChatLookup(myUserId, users);

  const submit = async () => {
    const found = await find(query);
    if (found) onFound(found);
  };

  return (
    <div className="channel-form">
      <label className="channel-field">
        <span>Email or username</span>
        <input
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="name@example.com or username"
          disabled={busy}
          autoFocus
        />
      </label>

      {error && <div className="channel-error">{error}</div>}

      <div className="channel-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void submit()}
          disabled={busy || !query.trim()}
        >
          {busy ? "Looking up…" : "Start chat"}
        </button>
      </div>
    </div>
  );
}
