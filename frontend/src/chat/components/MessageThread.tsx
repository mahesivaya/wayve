import type { ChatChannel, ChatMessage } from "../../api/chat";
import { formatTime, getStatusIcon } from "../utils";
import MessageAttachments from "./MessageAttachments";
import MessageText from "./MessageText";
import { PersonIcon } from "../../icons";

// Inbound Slack messages are stored as `[Slack · <author>] <text>` under the
// connecting Wayve user's id, so without special handling they'd render as the
// viewer's own message (right-aligned, no author). Parse out the Slack author
// and clean Slack's `<@U…>` / `<#C…>` / `<url|label>` markup so they render as
// received, with the real author shown.
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
        const slack = msg.content ? parseSlackMessage(msg.content) : null;
        // Slack-origin messages are never the viewer's own — always render them
        // as received (left), regardless of the stored sender id.
        const mine = !slack && msg.sender_id === currentUserId;
        const displayContent = slack ? slack.text : msg.content;
        // Who-sent-it label: the Slack author for bridged messages, else the
        // Wayve sender's name. Own messages need no label (they're right-aligned).
        const senderName = slack ? slack.author : (msg.sender_name ?? null);
        const showSender = !mine && !!senderName;
        const replyCount = msg.reply_count ?? 0;
        // Only top-level channel messages with an id can host a thread.
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
