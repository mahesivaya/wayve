// Linear-style circular progress glyph for a task status.
//
// Statuses are user-configurable, so both the colour and the glyph shape are now
// derived from data rather than from a per-status CSS class:
//
//   - colour comes from the status row's `color` and is applied as an inline
//     `color`, which `currentColor` then picks up. Passing no colour falls back
//     to `currentColor` inherited from the parent, so callers that only have a
//     category (the settings page's create row) still render sensibly.
//   - the fill fraction comes from the status's *category*, not its slug. A
//     custom "QA Review" in the in_progress category reads as half-filled with
//     no per-status entry needed anywhere.
//
// The fill is a stroke-dasharray arc on an inner circle: stroke-width 6 with
// radius 3 makes the stroke reach from the centre to the ring, so a partial dash
// reads as a filled pie wedge. Completed skips the arc and uses a solid disc
// plus a check; canceled uses a disc plus a cross.

import type { StatusCategory } from "../api/taskStatuses";

// How much of the ring each category fills. Exhaustive over StatusCategory, so
// adding a category is a compile error here rather than a silent empty ring.
const FILL: Record<StatusCategory, number> = {
  backlog: 0,
  planned: 0.25,
  in_progress: 0.5,
  completed: 1,
  canceled: 1,
};

const INNER_RADIUS = 3;
const CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;

export default function TaskStatusIcon({
  category,
  color,
  size = 14,
  className = "",
}: {
  category: StatusCategory;
  /** `#rrggbb` from the status row. Omit to inherit the parent's colour. */
  color?: string;
  size?: number;
  className?: string;
}) {
  const fill = FILL[category] ?? 0;
  const solid = category === "completed" || category === "canceled";

  return (
    <svg
      className={`task-status-icon ${className}`.trim()}
      style={color ? { color } : undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        opacity={category === "backlog" ? 0.55 : 1}
      />
      {solid ? (
        <>
          <circle cx="8" cy="8" r="6" fill="currentColor" />
          {category === "completed" ? (
            <path
              d="M5.2 8.2l1.9 1.9 3.7-3.9"
              stroke="var(--color-surface)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <path
              d="M6 6l4 4M10 6l-4 4"
              stroke="var(--color-surface)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          )}
        </>
      ) : fill > 0 ? (
        // Rotated -90deg so the wedge starts at 12 o'clock, like the reference.
        <circle
          cx="8"
          cy="8"
          r={INNER_RADIUS}
          stroke="currentColor"
          strokeWidth={INNER_RADIUS * 2}
          strokeDasharray={`${CIRCUMFERENCE * fill} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  );
}
