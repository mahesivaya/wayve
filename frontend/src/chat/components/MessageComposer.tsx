import { useRef, useState } from "react";
import type { Conversation } from "../types";

// A person the composer can @-mention. `label` is what gets inserted after the
// `@` (typically the email's local part); `email` is shown in the dropdown to
// disambiguate people who share a label.
export type MentionCandidate = { id: number; email: string; label: string };

type Props = {
  conversation: Conversation | null;
  canChat: boolean;
  isConnected: boolean;
  isReconnecting?: boolean;
  title: string;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  error?: string;
  onDismissError?: () => void;
  // People the current user can @-mention in this conversation (channel members
  // or the DM peer). Empty/omitted disables the mention picker.
  mentionCandidates?: MentionCandidate[];
  // Attachments (DMs only). When `allowAttachments` is false the paperclip is
  // hidden and pending files aren't shown.
  allowAttachments?: boolean;
  pendingFiles?: File[];
  onPickFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  uploading?: boolean;
};

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MENTION_SUGGESTIONS = 6;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Find an in-progress `@mention` immediately to the left of the caret. Returns
// the typed query (may be empty right after `@`) and the index of the `@` so we
// can splice a replacement in. The `@` must start the line or follow whitespace
// so emails/handles mid-word don't trigger it.
function activeMention(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const match = /(?:^|\s)@([\w.-]*)$/.exec(upto);
  if (!match) return null;
  const query = match[1];
  return { query, start: caret - query.length - 1 };
}

export default function MessageComposer({
  conversation,
  canChat,
  isConnected,
  isReconnecting = false,
  input,
  onInputChange,
  onSend,
  error,
  onDismissError,
  mentionCandidates = [],
  allowAttachments = false,
  pendingFiles = [],
  onPickFiles,
  onRemoveFile,
  uploading = false,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  if (!conversation || !canChat) return null;

  const disabled = !isConnected || uploading;
  const canSend =
    !disabled && (input.trim().length > 0 || pendingFiles.length > 0);

  // Candidates matching the active query (by label or email). Only surfaced
  // while a mention is being typed and there is at least one match.
  const q = (mentionQuery ?? "").toLowerCase();
  const matches =
    mentionQuery === null
      ? []
      : mentionCandidates
          .filter(
            (c) =>
              c.label.toLowerCase().includes(q) ||
              c.email.toLowerCase().includes(q)
          )
          .slice(0, MAX_MENTION_SUGGESTIONS);
  const mentionOpen = matches.length > 0;
  const highlighted = Math.min(mentionIndex, matches.length - 1);

  // Recompute the active mention from the textarea's current caret.
  const syncMention = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const mention = activeMention(el.value, caret);
    if (mention) {
      setMentionQuery(mention.query);
      setMentionStart(mention.start);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  // Replace the in-progress `@query` with `@label ` and drop the menu.
  const applyMention = (candidate: MentionCandidate) => {
    const el = textareaRef.current;
    const before = input.slice(0, mentionStart);
    const after = input.slice(mentionStart + 1 + (mentionQuery ?? "").length);
    const insert = `@${candidate.label} `;
    const next = before + insert + after;
    onInputChange(next);
    setMentionQuery(null);
    const caret = (before + insert).length;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  };

  const handlePick = (list: FileList | null) => {
    if (!list || !onPickFiles) return;
    const picked = Array.from(list).filter((f) => {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        return false;
      }
      return true;
    });
    if (picked.length) onPickFiles(picked);
  };

  return (
    <div className="chat-input">
      {error && (
        <div className="chat-compose-error" role="alert">
          <span>{error}</span>
          {onDismissError && (
            <button
              type="button"
              className="chat-compose-error-dismiss"
              onClick={onDismissError}
              aria-label="Dismiss error"
            >
              ×
            </button>
          )}
        </div>
      )}
      {disabled && (
        <div className="chat-compose-status" role="status">
          {uploading
            ? "Uploading…"
            : isReconnecting
              ? "Reconnecting…"
              : "Connecting…"}
        </div>
      )}

      {allowAttachments && pendingFiles.length > 0 && (
        <div className="chat-pending-files">
          {pendingFiles.map((f, i) => (
            <span className="chat-pending-file" key={`${f.name}-${i}`}>
              <span className="chat-pending-file-name">{f.name}</span>
              <span className="chat-pending-file-size">{fmtSize(f.size)}</span>
              {onRemoveFile && (
                <button
                  type="button"
                  className="chat-pending-file-remove"
                  onClick={() => onRemoveFile(i)}
                  aria-label={`Remove ${f.name}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                handlePick(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="chat-attach-btn"
              title="Attach files"
              aria-label="Attach files"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
          </>
        )}
        {mentionOpen && (
          <ul className="chat-mention-menu" role="listbox">
            {matches.map((candidate, i) => (
              <li
                key={`${candidate.id}-${candidate.email}`}
                role="presentation"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlighted}
                  className={`chat-mention-item${i === highlighted ? " active" : ""}`}
                  // onMouseDown (not onClick) so the textarea keeps focus and
                  // the caret splice lands correctly.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(candidate);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  <span className="chat-mention-label">@{candidate.label}</span>
                  <span className="chat-mention-email">{candidate.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => {
            onInputChange(e.target.value);
            syncMention(e.target);
          }}
          onClick={(e) => syncMention(e.currentTarget)}
          onKeyUp={(e) => {
            // Arrow/Home/End move the caret without changing text — resync.
            if (
              e.key.startsWith("Arrow") ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              syncMention(e.currentTarget);
            }
          }}
          disabled={!isConnected}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex(
                  (i) => (i - 1 + matches.length) % matches.length
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applyMention(matches[highlighted]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <button type="button" onClick={onSend} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}
