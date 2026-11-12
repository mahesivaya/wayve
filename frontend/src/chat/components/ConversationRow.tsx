import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RowMenuIcon } from "../../icons";

type Props = {
  /** Accessible name of the conversation, e.g. "#general" or an email. */
  label: string;
  /** The row's own select button. */
  children: ReactNode;
};

// A sidebar conversation row (DM or channel) with a ⋮ button on its right that
// opens a row menu, Slack-style. The menu's actions are still TBD. It is
// portalled to <body> so the scrolling sidebar can't clip it.
export default function ConversationRow({ label, children }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos !== null;

  const close = () => setPos(null);

  const toggle = () => {
    if (open) return close();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  // Closes on a click outside, Escape, or anything moving the row.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t))
        return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <div className={`conversation-row ${open ? "menu-open" : ""}`}>
      {children}
      <button
        ref={buttonRef}
        type="button"
        className="conversation-row-menu-btn"
        aria-label={`More options for ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <RowMenuIcon size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="conversation-row-menu"
            role="dialog"
            aria-label={`Options for ${label}`}
            style={{ top: pos.top, right: pos.right }}
          >
            <div className="conversation-row-menu-placeholder">TBD</div>
          </div>,
          document.body
        )}
    </div>
  );
}
