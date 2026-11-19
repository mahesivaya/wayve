import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChannelLinkIcon, LinkCopiedIcon, RowMenuIcon } from "../../icons";
import { copyText } from "../../utils/clipboard";

type Props = {
  /** Accessible name of the conversation, e.g. "#general" or an email. */
  label: string;
  /** The row's own select button. */
  children: ReactNode;
  /**
   * A channel's link (see `channelLink`). With it the row gets a ⋮ menu that
   * copies the link; a row without one, a DM, has no menu.
   */
  link?: string;
};

// A sidebar conversation row (DM or channel). A channel's row has a ⋮ button on
// its right that opens a row menu, Slack-style, holding "Copy channel link".
// The menu is portalled to <body> so the scrolling sidebar can't clip it.
export default function ConversationRow({ label, children, link }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const open = pos !== null;

  const close = () => {
    setPos(null);
    setCopied(false);
  };

  // Stays open a moment on "Link copied", so the copy is seen to have worked.
  const copyLink = () => {
    if (!link) return;
    void copyText(link).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(close, 900);
    });
  };

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

  if (!link) return <div className="conversation-row">{children}</div>;

  return (
    <div className={`conversation-row has-menu ${open ? "menu-open" : ""}`}>
      {children}
      <button
        ref={buttonRef}
        type="button"
        className="conversation-row-menu-btn"
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
            className="conversation-row-menu"
            role="menu"
            aria-label={`Options for ${label}`}
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              type="button"
              role="menuitem"
              className={`conversation-row-menu-item${copied ? " copied" : ""}`}
              onClick={copyLink}
            >
              <span className="conversation-row-menu-icon" aria-hidden="true">
                {copied ? (
                  <LinkCopiedIcon size={14} />
                ) : (
                  <ChannelLinkIcon size={14} />
                )}
              </span>
              <span className="conversation-row-menu-label">
                {copied ? "Link copied" : "Copy channel link"}
              </span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
