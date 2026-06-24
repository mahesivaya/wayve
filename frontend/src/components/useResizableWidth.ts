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
  // Invert the drag direction. Default (false) grows the panel as the pointer
  // moves right — correct for a left-anchored panel (e.g. the sidebar). Set
  // true for a right-anchored panel whose handle sits on its LEFT edge (e.g.
  // the chat thread panel), where dragging left should make it wider.
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

  // pointer-down handler for the drag handle. Delta style: capture the start
  // x + width, then track the pointer's movement relative to those. No element
  // ref needed, and no "jump" if the handle is grabbed slightly off its edge.
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
