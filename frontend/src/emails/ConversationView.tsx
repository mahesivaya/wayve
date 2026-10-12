import { useEffect, useState } from "react";
import EmailBody from "./EmailBody";
import { EmailAttachments } from "./EmailAttachments";
import { emailBodyErrorMessage } from "./bodyUtils";
import type { EmailItem } from "./types";
import { APP_TIME_ZONE } from "../utils/datetime";

// The earlier messages of an open conversation, oldest first, above the newest
// one (which the reading pane shows in full as before). Each starts collapsed
// to one line — who, when — and loads its body (and attachments) on first
// expand. Messages that were unread when the conversation opened start
// expanded instead, as in Gmail, since those are the ones you came to read.

type Loaded =
  | { state: "loading" }
  | { state: "ready"; email: EmailItem }
  | { state: "error"; message: string };

interface ConversationViewProps {
  // Earlier messages only, oldest first. The newest is rendered by the caller.
  messages: EmailItem[];
  loadMessage: (email: EmailItem) => Promise<EmailItem>;
  // For downloading (and decrypting) attachments.
  userId: number | null;
}

export function ConversationView({
  messages,
  loadMessage,
  userId,
}: ConversationViewProps) {
  // Unread messages start open and loading; the effect below fetches them.
  // The caller remounts this per conversation (key), so "unread" means unread
  // when this conversation was opened.
  const [startOpen] = useState(() =>
    messages.filter((m) => m.is_read === false).map((m) => m.id)
  );
  const [open, setOpen] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(startOpen.map((id) => [id, true]))
  );
  const [loaded, setLoaded] = useState<Record<number, Loaded>>(() =>
    Object.fromEntries(startOpen.map((id) => [id, { state: "loading" }]))
  );

  useEffect(() => {
    let cancelled = false;
    for (const message of messages) {
      if (!startOpen.includes(message.id)) continue;
      loadMessage(message).then(
        (email) => {
          if (cancelled) return;
          setLoaded((cur) => ({
            ...cur,
            [message.id]: { state: "ready", email },
          }));
        },
        (err: unknown) => {
          if (cancelled) return;
          setLoaded((cur) => ({
            ...cur,
            [message.id]: {
              state: "error",
              message: emailBodyErrorMessage(err),
            },
          }));
        }
      );
    }
    return () => {
      cancelled = true;
    };
  }, [messages, loadMessage, startOpen]);

  if (messages.length === 0) return null;

  const toggle = async (message: EmailItem) => {
    const willOpen = !open[message.id];
    setOpen((cur) => ({ ...cur, [message.id]: willOpen }));
    const state = loaded[message.id]?.state;
    if (!willOpen || state === "ready" || state === "loading") return;
    setLoaded((cur) => ({ ...cur, [message.id]: { state: "loading" } }));
    try {
      const email = await loadMessage(message);
      setLoaded((cur) => ({ ...cur, [message.id]: { state: "ready", email } }));
    } catch (err) {
      setLoaded((cur) => ({
        ...cur,
        [message.id]: { state: "error", message: emailBodyErrorMessage(err) },
      }));
    }
  };

  return (
    <ol
      className="conversation"
      aria-label="Earlier messages in this conversation"
    >
      {messages.map((message) => {
        const isOpen = !!open[message.id];
        const entry = loaded[message.id];
        return (
          <li key={message.id} className="conversation-message">
            <button
              type="button"
              className="conversation-message-head"
              aria-expanded={isOpen}
              onClick={() => void toggle(message)}
            >
              <span className="conversation-message-sender">
                {senderName(message.sender)}
              </span>
              <span className="conversation-message-date">
                {formatDate(message.created_at)}
              </span>
            </button>
            {isOpen && (
              <div className="conversation-message-body">
                {entry?.state === "ready" ? (
                  <>
                    <EmailBody body={entry.email.body || ""} />
                    <EmailAttachments
                      attachments={entry.email.attachments}
                      userId={userId}
                    />
                  </>
                ) : entry?.state === "error" ? (
                  <p className="email-body-error">{entry.message}</p>
                ) : (
                  <p className="conversation-message-loading">Loading…</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// "Ada Lovelace <ada@x.com>" → "Ada Lovelace"; a bare address stays as is.
function senderName(value?: string | null): string {
  const raw = value?.trim() || "";
  const match = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (match) return match[1].trim().replace(/^"|"$/g, "") || match[2].trim();
  return raw || "(unknown sender)";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: APP_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
