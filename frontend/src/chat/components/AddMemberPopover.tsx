import { useEffect, useRef } from "react";

type Props = {
  emails: string;
  error: string;
  onEmailsChange: (value: string) => void;
  onAdd: () => void;
  onClose: () => void;
};

// The header's "+ Add member" dropdown: just the invite field from channel
// settings, so inviting doesn't mean opening the whole settings panel. Closes
// on Escape or a click outside `.channel-add-member` (the button + this box).
export default function AddMemberPopover({
  emails,
  error,
  onEmailsChange,
  onAdd,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".channel-add-member")) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  return (
    <div
      className="channel-add-member-popover"
      role="dialog"
      aria-label="Invite people"
    >
      <span className="channel-settings-label">Invite people</span>
      <div className="channel-invite-row">
        <input
          ref={inputRef}
          className="channel-settings-input"
          value={emails}
          onChange={(e) => onEmailsChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="email, email…"
          aria-label="Emails to invite"
        />
        <button
          type="button"
          className="channel-settings-primary"
          onClick={onAdd}
          disabled={!emails.trim()}
        >
          Add
        </button>
      </div>
      {error && <div className="channel-error">{error}</div>}
    </div>
  );
}
