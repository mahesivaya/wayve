import type { ChatChannel, ChatMessage } from "../../api/chat";
import { formatTime, getStatusIcon } from "../utils";
import MessageAttachments from "./MessageAttachments";
import MessageReactions from "./MessageReactions";
import MessageText from "./MessageText";
import { PersonIcon } from "../../icons";

// Inbound Slack messages are stored under the connecting Wayve user's id, so without
// parsing the author back out they would render as the viewer's own message. The
// replacements below also strip Slack's `<@U…>` / `<#C…>` / `<url|label>` markup.
const SLACK_RE = /^\[Slack · (.+?)\]\s?([\s\S]*)$/;

function parseSlackMessage(
  content: string
): { author: string; text: string } | null {
  const m = content.match(SLACK_RE);
  if (!m) return null;
  const text = m[2]
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(?:https?:)?[^|>]*\|([^>]+)>/g, "$1")
    .replace(/<(https?:[^>]+)>/g, "$1");
  return { author: m[1], text };
}

type Props = {
  messages: ChatMessage[];
  selectedChannel: ChatChannel | null;
  currentUserId?: number;
  // Channels only: the WS rejects parent_message_id on DMs, so DM contexts pass null
  // and the hover action is hidden.
  onOpenThread?: ((message: ChatMessage) => void) | null;
  // Omitting this hides the reaction row.
  onToggleReaction?: (
    messageId: number,
    isChannel: boolean,
    emoji: string
  ) => void;
};

export default function MessageThread({
  messages,
  selectedChannel,
  currentUserId,
  onOpenThread,
  onToggleReaction,
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

  // Threaded replies belong to the side panel only. `parent_message_id` is undefined
  // on DM rows, which makes them all top-level by definition.
  const topLevel = messages.filter((m) => m.parent_message_id == null);

  return (
    <div className="messages">
      {topLevel.map((msg, i) => {
        const slack = msg.content ? parseSlackMessage(msg.content) : null;
        // A Slack-origin message is never the viewer's own, whatever sender id it was
        // stored under, so it always renders as received.
        const mine = !slack && msg.sender_id === currentUserId;
        const displayContent = slack ? slack.text : msg.content;
        const senderName = slack ? slack.author : (msg.sender_name ?? null);
        const showSender = !mine && !!senderName;
        const replyCount = msg.reply_count ?? 0;
        const canOpenThread =
          !!onOpenThread && msg.message_id != null && selectedChannel != null;

        return (
          <div
            key={msg.message_id ?? i}
            className={`message ${mine ? "me" : ""}`}
          >
            <div
              className={`bubble ${mine ? "me" : "other"}${
                slack ? " bubble--slack" : ""
              }`}
            >
              {showSender && senderName && (
                <div className="bubble-sender">
                  {slack ? (
                    <span className="bubble-sender-badge">Slack</span>
                  ) : (
                    <span
                      className="bubble-avatar"
                      style={{ background: "#94a3b8" }}
                      aria-hidden="true"
                    >
                      <PersonIcon size={14} />
                    </span>
                  )}
                  {senderName}
                </div>
              )}
              {displayContent && (
                <div>
                  <MessageText text={displayContent} />
                </div>
              )}
              <MessageAttachments message={msg} currentUserId={currentUserId} />
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
            {onToggleReaction && (
              <MessageReactions
                message={msg}
                currentUserId={currentUserId}
                onToggle={onToggleReaction}
              />
            )}
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
