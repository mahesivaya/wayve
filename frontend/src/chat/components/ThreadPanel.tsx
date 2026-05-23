// Right-side panel that opens when the user clicks "Reply in thread" on a
// channel message. Shows the parent + every reply under it + a composer that
// posts new messages with `parent_message_id` set. Live WS messages flowing
// through Chat.tsx are mirrored here via the `replies` prop — this component
// is purely presentational and doesn't open its own socket.

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../api/chat";
import { formatTime } from "../utils";

type Props = {
  parent: ChatMessage;
  replies: ChatMessage[];
  currentUserId?: number;
  isConnected: boolean;
  onClose: () => void;
  onSendReply: (text: string) => void | Promise<void>;
};

export default function ThreadPanel({
  parent,
  replies,
  currentUserId,
  isConnected,
  onClose,
  onSendReply,
}: Props) {
  const [draft, setDraft] = useState("");
  const tailRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the newest reply as they arrive.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies.length]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !isConnected) return;
    setDraft("");
    await onSendReply(text);
  };

  return (
    <aside className="thread-panel">
      <header className="thread-panel-header">
        <h3>Thread</h3>
        <button type="button" onClick={onClose} aria-label="Close thread">
          ×
        </button>
      </header>

      <div className="thread-panel-body">
        <div className={`message ${parent.sender_id === currentUserId ? "me" : ""}`}>
          <div className={`bubble ${parent.sender_id === currentUserId ? "me" : "other"}`}>
            <div>{parent.content}</div>
            <div className="message-meta">{formatTime(parent.created_at)}</div>
          </div>
        </div>

        {replies.length > 0 && (
          <div className="thread-divider">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </div>
        )}

        {replies.map((reply, i) => {
          const mine = reply.sender_id === currentUserId;
          return (
            <div key={reply.message_id ?? `r-${i}`} className={`message ${mine ? "me" : ""}`}>
              <div className={`bubble ${mine ? "me" : "other"}`}>
                <div>{reply.content}</div>
                <div className="message-meta">{formatTime(reply.created_at)}</div>
              </div>
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
          rows={2}
        />
        <button type="button" onClick={() => void submit()} disabled={!isConnected || !draft.trim()}>
          Reply
        </button>
      </div>
    </aside>
  );
}
