import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SNOOZE_PRESETS, formatSnoozeTime, snoozeEnd } from "./snoozePresets";

const MENU_WIDTH = 220;
const GAP = 4;

interface SnoozeMenuProps {
  // The button the menu belongs to; it is positioned against this.
  anchor: HTMLElement;
  onPick: (until: Date) => void;
  onClose: () => void;
}

// Rendered on <body>, not inside the row: `.email-item` clips its overflow for
// single-line truncation, which would cut off any menu drawn within it. Fixed
// to the anchor's on-screen position, flipped above it near the bottom of the
// screen, and closed on scroll or resize rather than left behind.
export function SnoozeMenu({ anchor, onPick, onClose }: SnoozeMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Hosts pass a fresh `onClose` every render; reading it through a ref keeps
  // the listeners below from being torn down and re-added each time.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  const [position, setPosition] = useState<{ top: number; left: number }>(
    () => {
      const rect = anchor.getBoundingClientRect();
      return { top: rect.bottom + GAP, left: rect.right - MENU_WIDTH };
    }
  );
  // Re-rendered each minute so the times shown stay right while it is open.
  const [now, setNow] = useState(() => new Date());

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? 0;
    const below = rect.bottom + GAP;
    const top =
      below + height > window.innerHeight
        ? Math.max(GAP, rect.top - GAP - height)
        : below;
    const left = Math.min(
      Math.max(GAP, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - GAP
    );
    setPosition({ top, left });
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [anchor]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || anchor.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onScroll = (event: Event) => {
      // Scrolling inside the menu itself is not a reason to close it.
      if (event.target instanceof Node && menuRef.current?.contains(event.target))
        return;
      close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      // Back to the button that opened it, for keyboard users; unless the
      // row (and its button) left the page, as after a snooze.
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={menuRef}
      className="snooze-menu"
      role="menu"
      aria-label="Snooze until"
      style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="snooze-menu-title">Snooze until…</div>
      {SNOOZE_PRESETS.map((preset) => (
        <button
          key={preset.minutes}
          type="button"
          role="menuitem"
          className="snooze-menu-item"
          onClick={() => onPick(snoozeEnd(preset.minutes))}
        >
          <span>{preset.label}</span>
          <span className="snooze-menu-time">
            {formatSnoozeTime(snoozeEnd(preset.minutes, now))}
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
