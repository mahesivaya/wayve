import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RowMenuIcon } from "../icons";

type Props = {
  /** The note's name, for the button's and menu's accessible names. */
  label: string;
  onDelete: () => void;
};

// The ⋮ button at the end of a note's row and the menu it opens. The menu is
// portalled to <body> so the scrolling list can't clip it (as ConversationRow).
export default function NoteRowMenu({ label, onDelete }: Props) {
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
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`note-row-menu-btn${open ? " is-open" : ""}`}
        aria-label={`More options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <RowMenuIcon size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="note-row-menu"
            role="menu"
            aria-label={`Options for ${label}`}
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              type="button"
              role="menuitem"
              className="note-row-menu-item is-danger"
              onClick={() => {
                close();
                onDelete();
              }}
            >
              Delete
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
