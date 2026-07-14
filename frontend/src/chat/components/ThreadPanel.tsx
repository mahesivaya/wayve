// Purely presentational: Chat.tsx owns the socket and mirrors live WS replies in via
// the `replies` prop, and its composer posts with `parent_message_id` set.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChatMessage } from "../../api/chat";
import { formatTime } from "../utils";
import MessageReactions from "./MessageReactions";
import MessageText from "./MessageText";

type Props = {
  parent: ChatMessage;
  replies: ChatMessage[];
  currentUserId?: number;
  isConnected: boolean;
  onClose: () => void;
  onSendReply: (text: string) => void | Promise<void>;
  onToggleReaction?: (
    messageId: number,
    isChannel: boolean,
    emoji: string
  ) => void;
  // Applied as a CSS variable rather than an inline `width`, so the narrow-mode
  // takeover rule (which sets width:auto) still wins.
  width?: number;
};

export default function ThreadPanel({
  parent,
  replies,
  currentUserId,
  isConnected,
  onClose,
  onSendReply,
  onToggleReaction,
  width,
}: Props) {
  const [draft, setDraft] = useState("");
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies.length]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !isConnected) return;
    setDraft("");
    await onSendReply(text);
  };

  const widthVar =
    width != null
      ? ({ "--thread-width": `${width}px` } as CSSProperties)
      : undefined;

  return (
    <aside className="thread-panel" style={widthVar}>
      <header className="thread-panel-header">
        <h3>Thread</h3>
        <button type="button" onClick={onClose} aria-label="Close thread">
          ×
        </button>
      </header>

      <div className="thread-panel-body">
        <div
          className={`message ${parent.sender_id === currentUserId ? "me" : ""}`}
        >
          <div
            className={`bubble ${parent.sender_id === currentUserId ? "me" : "other"}`}
          >
            <div>
              <MessageText text={parent.content} />
            </div>
            <div className="message-meta">{formatTime(parent.created_at)}</div>
          </div>
          {onToggleReaction && (
            <MessageReactions
              message={parent}
              currentUserId={currentUserId}
              onToggle={onToggleReaction}
            />
          )}
        </div>

        {replies.length > 0 && (
          <div className="thread-divider">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </div>
        )}

        {replies.map((reply, i) => {
          const mine = reply.sender_id === currentUserId;
          return (
            <div
              key={reply.message_id ?? `r-${i}`}
              className={`message ${mine ? "me" : ""}`}
            >
              <div className={`bubble ${mine ? "me" : "other"}`}>
                <div>
                  <MessageText text={reply.content} />
                </div>
                <div className="message-meta">
                  {formatTime(reply.created_at)}
                </div>
              </div>
              {onToggleReaction && (
                <MessageReactions
                  message={reply}
                  currentUserId={currentUserId}
                  onToggle={onToggleReaction}
                />
              )}
            </div>
          );
        })}
        <div ref={tailRef} />
      </div>

      <div className="thread-panel-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!isConnected}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={isConnected ? "Reply in thread…" : "Connecting…"}
          rows={1}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!isConnected || !draft.trim()}
        >
          Reply
        </button>
      </div>
    </aside>
  );
}
