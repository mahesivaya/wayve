import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Drag-to-resize a panel's pixel width, with localStorage persistence. Pixel
// widths only: the split-pane flex weights and the SplitView percentage use
// different math and are deliberately kept separate.

export interface ResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  // Set for a right-anchored panel whose handle sits on its left edge, where
  // dragging left should widen it. The default suits a left-anchored panel.
  invert?: boolean;
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  invert = false,
}: ResizableWidthOptions) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return Number.isFinite(v) && v > 0
        ? Math.min(max, Math.max(min, v))
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      // private mode / quota — width just won't persist this session.
    }
  }, [storageKey, width]);

  // Tracks the pointer as a delta from the start x and width, so the panel
  // doesn't jump when the handle is grabbed slightly off its edge.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      const delta = invert ? startX - ev.clientX : ev.clientX - startX;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  return { width, setWidth, startResize };
}
