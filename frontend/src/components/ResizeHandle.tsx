import type { PointerEvent as ReactPointerEvent } from "react";

// Shared draggable divider used with useResizableWidth. Styled by the
// `.resize-handle` rule in Layout.css (a wide hit area + center line + grip).
export default function ResizeHandle({
  onPointerDown,
  className,
  ariaLabel = "Resize",
}: {
  onPointerDown: (e: ReactPointerEvent) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={className ? `resize-handle ${className}` : "resize-handle"}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
    />
  );
}
