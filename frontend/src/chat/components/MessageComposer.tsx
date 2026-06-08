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
};

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
      {disabled && (
        <div className="chat-compose-status" role="status">
          {isReconnecting ? "Reconnecting…" : "Connecting…"}
        </div>
      )}
      <div className="chat-input-row">
        <textarea
          rows={1}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled) onSend();
            }
          }}
        />
        <button type="button" onClick={onSend} disabled={disabled}>
          Send
        </button>
      </div>
    </div>
  );
}
