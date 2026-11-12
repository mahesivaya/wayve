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

/** Which tab strip a tab belongs to: the main view's, or the right group's. */
export type TabStripId = "main" | "right";

/** A tab dragged out of a strip: carries its exact URL (Cursor-style). */
export type TabDragPayload = {
  kind: "tab";
  tabId: string;
  path: string;
  title: string;
  source: TabStripId;
};

export type PaneDragPayload =
  /** Dragged out of the sidebar: opens a new app. */
  | { kind: "app"; app: AppKey }
  | TabDragPayload
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
    if (
      o.kind === "tab" &&
      typeof o.tabId === "string" &&
      typeof o.path === "string" &&
      o.path.startsWith("/")
    ) {
      const title = typeof o.title === "string" ? o.title : o.path;
      const source: TabStripId = o.source === "right" ? "right" : "main";
      return { kind: "tab", tabId: o.tabId, path: o.path, title, source };
    }
    if (o.kind === "pane" && isPaneKey(o.from)) {
      const half = o.half === "top" || o.half === "bottom" ? o.half : undefined;
      return { kind: "pane", from: o.from, half };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The split-pane app a header tab's URL belongs to. Detail pages resolve to
 * their board (`/tickets/5` → tickets) since panes hold apps, not records.
 * Null when the route isn't a split-pane app (settings, platform pages, …).
 */
export function appKeyForTabPath(pathname: string): AppKey | null {
  if (pathname === "/" || pathname === "/home") return "home";
  const match = SPLIT_APPS.filter(
    (a) =>
      a.path !== "/" &&
      (pathname === a.path || pathname.startsWith(`${a.path}/`))
  ).sort((a, b) => b.path.length - a.path.length)[0];
  return match?.key ?? null;
}

/**
 * Header-tab drags split only once the pointer is past the middle of the pane:
 * the right half opens the tab beside the page, the left half does nothing.
 */
export function tabDropZoneFromPointer(
  rect: { left: number; width: number },
  x: number
): DropZone | null {
  if (rect.width <= 0) return null;
  return (x - rect.left) / rect.width > 0.5 ? "right" : null;
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
