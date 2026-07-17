// A toggle button shown in each open pane's toolbar, just before the ✕. Clicking
// it splits THAT pane horizontally into two stacked halves (a duplicate of the
// pane's app); clicking again removes the sub-split. Independent per pane — it
// never affects the other panes. The glyph is a framed pane divided top/bottom.

export default function PaneSplitMenu({
  active,
  onToggle,
}: {
  /** True when this pane is currently sub-split. */
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`split-menu-btn${active ? " active" : ""}`}
      onClick={onToggle}
      title={active ? "Remove split" : "Split this pane"}
      aria-label={active ? "Remove split" : "Split this pane"}
      aria-pressed={active}
    >
      {/* Framed pane divided top/bottom — the vertical-split glyph. */}
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
        <line x1="3.5" y1="12" x2="20.5" y2="12" />
      </svg>
    </button>
  );
}
