import { useEffect, useRef, useState } from "react";

// Header split control: one icon in the top-right that opens a small menu asking
// which way to split — horizontal (a second side-by-side column) or vertical
// (stack the focused pane top/bottom). A direction is dropped from the menu once
// it already exists, so the menu only ever offers a split that can be made. When
// neither is possible the whole control is hidden.

// Mac reports "Mac…" here; everything else gets Ctrl. Cosmetic hint only.
const MOD =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";

// Framed pane split into two columns — the "open a second column" glyph.
function ColumnsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <line x1="12" y1="4.5" x2="12" y2="19.5" />
    </svg>
  );
}

// Framed pane split top/bottom — the "stack into halves" glyph.
function RowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
    </svg>
  );
}

export default function SplitMenu({
  canSplitHorizontal,
  canSplitVertical,
  onSplitHorizontal,
  onSplitVertical,
}: {
  canSplitHorizontal: boolean;
  canSplitVertical: boolean;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Esc — same pattern as ProfileMenu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing left to offer — hide the control entirely rather than open an empty
  // menu.
  if (!canSplitHorizontal && !canSplitVertical) return null;

  const choose = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <div className="split-menu" ref={ref}>
      <button
        type="button"
        className={`split-menu-btn${open ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        data-tooltip="Split view"
        aria-label="Split view"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
          <line x1="12" y1="3.5" x2="12" y2="20.5" />
        </svg>
      </button>

      {open && (
        <div className="split-menu-pop" role="menu">
          {/* Labels follow the divider's orientation, not the action name: a
              second column is separated by a *vertical* divider, so it reads as
              "Split vertically". The glyph and handler are what actually run. */}
          {canSplitHorizontal && (
            <button
              type="button"
              role="menuitem"
              className="split-menu-item"
              onClick={() => choose(onSplitHorizontal)}
            >
              <span className="split-menu-item-glyph" aria-hidden="true">
                <ColumnsGlyph />
              </span>
              <span className="split-menu-item-label">Split vertically</span>
              <span className="split-menu-item-kbd" aria-hidden="true">
                {MOD}\
              </span>
            </button>
          )}
          {canSplitVertical && (
            <button
              type="button"
              role="menuitem"
              className="split-menu-item"
              onClick={() => choose(onSplitVertical)}
            >
              <span className="split-menu-item-glyph" aria-hidden="true">
                <RowsGlyph />
              </span>
              <span className="split-menu-item-label">Split horizontally</span>
              <span className="split-menu-item-kbd" aria-hidden="true">
                {MOD}⇧\
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
