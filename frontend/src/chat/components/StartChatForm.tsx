import { useState } from "react";
import { findChatUserByEmail, type ChatUser } from "../../api/chat";

type Props = {
  myUserId: number;
  users: ChatUser[];
  onFound: (user: ChatUser) => void;
  onCancel: () => void;
};

// "+" next to Users: start a DM by typing someone's email, including people not
// yet in the directory (personal accounts only list people you've talked to).
export default function StartChatForm({
  myUserId,
  users,
  onFound,
  onCancel,
}: Props) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = email.trim().toLowerCase();
    if (!value || busy) return;
    setError("");

    const known = users.find((u) => u.email.toLowerCase() === value);
    if (known) {
      onFound(known);
      return;
    }

    setBusy(true);
    try {
      const found = await findChatUserByEmail(value);
      if (!found) {
        setError("No account is associated with this email address.");
      } else if (found.id === myUserId) {
        setError("That's your own email.");
      } else {
        onFound(found);
      }
    } catch {
      setError("Couldn't look up that email. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="channel-form">
      <label className="channel-field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="name@example.com"
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
          disabled={busy || !email.trim()}
        >
          {busy ? "Looking up…" : "Start chat"}
        </button>
      </div>
    </div>
  );
}
