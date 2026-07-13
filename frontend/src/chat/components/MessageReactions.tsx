import { useRef, useState } from "react";
import type { ChatMessage } from "../../api/chat";
import EmojiPicker from "./EmojiPicker";

type Props = {
  message: ChatMessage;
  currentUserId?: number;
  /** Toggle the viewer's reaction. Adding an emoji you already used removes it. */
  onToggle: (messageId: number, isChannel: boolean, emoji: string) => void;
};

// The reaction row under a message bubble: one pill per emoji (with its count,
// highlighted when the viewer is among the reactors) plus an add-reaction
// button that opens the same picker the composer uses.
//
// A pill click toggles, so the pill is both "who reacted" and the control to
// join or leave that reaction — which is why it's a button with aria-pressed
// rather than a static count.
export default function MessageReactions({
  message,
  currentUserId,
  onToggle,
}: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const messageId = message.message_id;
  // An optimistic bubble has no server id yet, so there's nothing to react to.
  if (messageId == null) return null;

  const isChannel = message.channel_id != null;
  const groups = message.reactions ?? [];

  const toggle = (emoji: string) => {
    onToggle(messageId, isChannel, emoji);
    setPickerOpen(false);
  };

  return (
    <div className="message-reactions">
      {groups.map((group) => {
        const count = group.user_ids.length;
        const mine =
          currentUserId != null && group.user_ids.includes(currentUserId);
        return (
          <button
            key={group.emoji}
            type="button"
            className={`reaction-pill${mine ? " reaction-pill--mine" : ""}`}
            aria-pressed={mine}
            aria-label={`${group.emoji} ${count} ${
              count === 1 ? "reaction" : "reactions"
            }`}
            title={mine ? "Remove your reaction" : "React"}
            onClick={() => toggle(group.emoji)}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span className="reaction-count">{count}</span>
          </button>
        );
      })}

      <div className="reaction-add-anchor" ref={anchorRef}>
        {pickerOpen && (
          <EmojiPicker
            anchorRef={anchorRef}
            onSelect={toggle}
            onClose={() => setPickerOpen(false)}
          />
        )}
        <button
          type="button"
          className="reaction-add"
          aria-label="Add reaction"
          aria-expanded={pickerOpen}
          title="Add reaction"
          onClick={() => setPickerOpen((open) => !open)}
        >
          ☺
        </button>
      </div>
    </div>
  );
}
