import type { ChatChannel, ChatMessage } from "../../api/chat";
import { formatTime, getStatusIcon } from "../utils";

type Props = {
  messages: ChatMessage[];
  selectedChannel: ChatChannel | null;
  currentUserId?: number;
  // Channel-only: open a thread side panel for a top-level message. Direct
  // messages don't support threads (the WS rejects parent_message_id on DMs),
  // so DM contexts pass null here and the hover action is hidden.
  onOpenThread?: ((message: ChatMessage) => void) | null;
};

export default function MessageThread({
  messages,
  selectedChannel,
  currentUserId,
  onOpenThread,
}: Props) {
  if (selectedChannel && !selectedChannel.is_member) {
    return (
      <div className="messages">
        <div className="channel-join-empty">
          <strong>{selectedChannel.name}</strong>
          <span>
            {selectedChannel.visibility === "public"
              ? "Join this public channel to read and write messages."
              : "Request admin approval to join this private channel."}
          </span>
        </div>
      </div>
    );
  }

  // Threaded replies live in the side panel only — keep the main feed clean.
  // `parent_message_id` is undefined for DM rows (no column on `messages`),
  // which makes them all top-level by definition.
  const topLevel = messages.filter((m) => m.parent_message_id == null);

  return (
    <div className="messages">
      {topLevel.map((msg, i) => {
        const mine = msg.sender_id === currentUserId;
        const replyCount = msg.reply_count ?? 0;
        // Only top-level channel messages with an id can host a thread.
        const canOpenThread =
          !!onOpenThread && msg.message_id != null && selectedChannel != null;

        return (
          <div
            key={msg.message_id ?? i}
            className={`message ${mine ? "me" : ""}`}
          >
            <div className={`bubble ${mine ? "me" : "other"}`}>
              <div>{msg.content}</div>
              <div className="message-meta">
                {formatTime(msg.created_at)}{" "}
                {mine && msg.status && (
                  <span
                    className={`message-status${
                      msg.status === "read" ? " message-status--read" : ""
                    }`}
                    title={msg.status}
                    aria-label={msg.status}
                  >
                    {getStatusIcon(msg.status)}
                  </span>
                )}
              </div>
              {canOpenThread && (
                <button
                  type="button"
                  className="message-thread-action"
                  onClick={() => onOpenThread!(msg)}
                  title="Reply in thread"
                >
                  💬
                </button>
              )}
            </div>
            {replyCount > 0 && canOpenThread && (
              <button
                type="button"
                className="message-reply-count"
                onClick={() => onOpenThread!(msg)}
              >
                {replyCount} {replyCount === 1 ? "reply" : "replies"} →
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
