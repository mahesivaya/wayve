import { useRef } from "react";
import type { Conversation } from "../types";

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
  // Attachments (DMs only). When `allowAttachments` is false the paperclip is
  // hidden and pending files aren't shown.
  allowAttachments?: boolean;
  pendingFiles?: File[];
  onPickFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  uploading?: boolean;
};

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  allowAttachments = false,
  pendingFiles = [],
  onPickFiles,
  onRemoveFile,
  uploading = false,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  if (!conversation || !canChat) return null;

  const disabled = !isConnected || uploading;
  const canSend = !disabled && (input.trim().length > 0 || pendingFiles.length > 0);

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
        <textarea
          rows={1}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={!isConnected}
          onKeyDown={(e) => {
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
