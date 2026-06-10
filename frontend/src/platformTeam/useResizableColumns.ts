import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

// Drag-resizable table columns, persisted to localStorage. Extracted from the
// App Logs table (PlatformLogs) so the Visitors / User Logs tables can share
// the exact same "grab the grip on a header's right edge and drag" behavior.
//
// Pair with: a `table-layout: fixed` table whose `width` is the returned
// `totalWidth`, a <colgroup> of <col> driven by `colWidths`, header cells with
// the `.pt-th-resizable` class hosting a `.pt-col-resize-handle` whose
// onMouseDown is `startResize(key, min)`, all inside an `overflow-x: auto`
// wrapper so the table scrolls sideways when dragged wider than the pane.

export type ResizableColumn = {
  key: string;
  label: string;
  /** Default width in px. */
  width: number;
  /** Floor width in px when dragging. */
  min: number;
};

export function useResizableColumns(
  columns: readonly ResizableColumn[],
  storageKey: string
) {
  // Per-column widths (px). Defaults come from `columns`; a stored value
  // overrides but is floored at the column's min.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = {};
    for (const c of columns) defaults[c.key] = c.width;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const c of columns) {
          const v = parsed[c.key];
          if (typeof v === "number" && Number.isFinite(v)) {
            defaults[c.key] = Math.max(c.min, v);
          }
        }
      }
    } catch {
      // ignore malformed / unavailable storage — fall back to defaults
    }
    return defaults;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(colWidths));
    } catch {
      // private mode / quota — widths just won't persist this session
    }
  }, [colWidths, storageKey]);

  // Drag the grip on a header's right edge to resize that column. Listeners
  // live only for the duration of the drag.
  const startResize = (key: string, min: number) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[key];
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(min, startW + (ev.clientX - startX));
      setColWidths((prev) =>
        prev[key] === next ? prev : { ...prev, [key]: next }
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const totalWidth = columns.reduce((sum, c) => sum + colWidths[c.key], 0);

  return { colWidths, totalWidth, startResize };
}
