import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Shared "drag a handle to resize a panel's width (px)" logic, extracted from
// the several near-identical copies in Layout / Chat / GitHub. Mirrors the
// existing useResizableColumns hook (state + localStorage persistence + a
// pointer-drag handler). Pixel widths only — the split-pane flex weights and
// SplitView percentage use different math and are intentionally separate.

export interface ResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
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

  // pointer-down handler for the drag handle. Delta style: capture the start
  // x + width, then track the pointer's movement relative to those. No element
  // ref needed, and no "jump" if the handle is grabbed slightly off its edge.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      setWidth(
        Math.min(max, Math.max(min, startWidth + (ev.clientX - startX))),
      );
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
