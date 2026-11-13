import { useState } from "react";
import { findChatUserByEmail, type ChatUser } from "../../api/chat";

// Finds someone to DM by email or username, including people not yet in the
// directory (personal accounts only list people you've talked to). Shared by
// the New conversation page and the "+" next to Users.
export function useStartChatLookup(myUserId: number, users: ChatUser[]) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Resolves to the person to open a chat with, or null after setting `error`.
  const find = async (raw: string): Promise<ChatUser | null> => {
    const value = raw.trim().toLowerCase();
    if (!value || busy) return null;
    setError("");

    const known = users.find((u) => u.email.toLowerCase() === value);
    if (known) return known;

    setBusy(true);
    try {
      const found = await findChatUserByEmail(value);
      if (!found) {
        setError("No account matches that email or username.");
      } else if (found.id === myUserId) {
        setError("That's your own account.");
      } else if (found.can_message === false) {
        setError(
          "You can't message this person. Direct messages are limited to your own organization (or other personal accounts), plus platform support."
        );
      } else {
        return found;
      }
    } catch {
      setError("Couldn't look that up. Try again.");
    } finally {
      setBusy(false);
    }
    return null;
  };

  return { find, error, setError, busy };
}
