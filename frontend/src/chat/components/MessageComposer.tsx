import type { Conversation } from "../types";

type Props = {
  conversation: Conversation | null;
  canChat: boolean;
  isConnected: boolean;
  title: string;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  error?: string;
  onDismissError?: () => void;
};

export default function MessageComposer({
  conversation,
  canChat,
  isConnected,
  title,
  input,
  onInputChange,
  onSend,
  error,
  onDismissError,
}: Props) {
  if (!conversation || !canChat) return null;

  const disabled = !isConnected;

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
      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled) onSend();
            }
          }}
          placeholder={disabled ? "Connecting to chat..." : `Message ${title}`}
        />
        <button type="button" onClick={onSend} disabled={disabled}>
          Send
        </button>
      </div>
    </div>
  );
}
