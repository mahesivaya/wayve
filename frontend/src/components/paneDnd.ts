import { SPLIT_APPS, type AppKey } from "./LayoutConfig";

// Drag-and-drop plumbing for the split panes: drag a sidebar app (or an already
// open pane) onto a pane and drop it on an edge to place it there.
//
// Deliberately free of React and of Layout's state so the geometry and payload
// rules can be unit-tested directly.

export type PaneKey = "left" | "center" | "right";
export type PaneHalf = "top" | "bottom";

/** Which region of a pane the pointer is over during a drag. */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

// A private MIME type, not "text/plain". Drive and Documents already bind
// onDrop to upload OS files (drive/DriveBox.tsx, documents/DocumentsBox.tsx),
// so pane drop targets must be able to recognise our own drags and ignore
// everything else — otherwise dropping a file on Drive would split the pane
// instead of uploading.
export const PANE_DND_MIME = "application/x-wayve-pane";

export type PaneDragPayload =
  /** Dragged out of the sidebar: opens a new app. */
  | { kind: "app"; app: AppKey }
  /** Dragged by an open pane's title: moves/swaps that pane. */
  | { kind: "pane"; from: PaneKey; half?: PaneHalf };

const isPaneKey = (v: unknown): v is PaneKey =>
  v === "left" || v === "center" || v === "right";

const isAppKey = (v: unknown): v is AppKey =>
  typeof v === "string" && SPLIT_APPS.some((a) => a.key === v);

export function setPaneDragData(dt: DataTransfer, payload: PaneDragPayload) {
  dt.effectAllowed = "move";
  dt.setData(PANE_DND_MIME, JSON.stringify(payload));
}

/**
 * True when this drag is one of ours. Safe to call during `dragover`, where the
 * spec exposes only `types` — `getData` returns "" until `drop`, which is why
 * the hover path can't use `readPaneDragData`.
 */
export function hasPaneDragData(dt: DataTransfer | null): boolean {
  return dt ? Array.from(dt.types).includes(PANE_DND_MIME) : false;
}

/** Reads the payload. Only meaningful during `drop`. Null if not ours/malformed. */
export function readPaneDragData(
  dt: DataTransfer | null
): PaneDragPayload | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(PANE_DND_MIME);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (o.kind === "app" && isAppKey(o.app)) {
      return { kind: "app", app: o.app };
    }
    if (o.kind === "pane" && isPaneKey(o.from)) {
      const half =
        o.half === "top" || o.half === "bottom" ? o.half : undefined;
      return { kind: "pane", from: o.from, half };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fraction of the pane's width/height treated as an edge. Inside any edge band
 * the drop splits; everything further in replaces.
 */
export const EDGE_BAND = 0.25;

/**
 * Which zone the pointer is in, by proximity to the nearest edge. Ties resolve
 * left → right → top → bottom, which only matters in the exact corners.
 */
export function dropZoneFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number
): DropZone {
  // A zero-sized rect has no meaningful edges; treat the whole thing as centre
  // rather than dividing by zero.
  if (rect.width <= 0 || rect.height <= 0) return "center";

  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;

  const toLeft = fx;
  const toRight = 1 - fx;
  const toTop = fy;
  const toBottom = 1 - fy;

  const nearest = Math.min(toLeft, toRight, toTop, toBottom);
  if (nearest > EDGE_BAND) return "center";
  if (nearest === toLeft) return "left";
  if (nearest === toRight) return "right";
  if (nearest === toTop) return "top";
  return "bottom";
}
