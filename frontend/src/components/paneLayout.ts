import type { AppKey } from "./LayoutConfig";
import type {
  DropZone,
  PaneDragPayload,
  PaneHalf,
  PaneKey,
} from "./paneDnd";

// The pane arrangement, extracted from Layout's state so the drop rules are a
// pure function. Layout owns the setters; this owns the decisions.
//
// The model is fixed-slot, not a tree: three columns, each optionally split
// once into two stacked halves. Max six panes.
export type PaneArrangement = {
  /** The routed column. Never empty — the app always shows *something*. */
  left: AppKey;
  center: AppKey | null;
  right: AppKey | null;
  subSplit: Record<PaneKey, boolean>;
  subBottomView: Record<PaneKey, AppKey>;
};

export type PaneDropResult = {
  next: PaneArrangement;
  focus: { pane: PaneKey; half: PaneHalf };
  /** Set when the routed column's app changed; the caller must navigate(). */
  navigateTo?: AppKey;
};

const COLUMNS: PaneKey[] = ["left", "center", "right"];

const clone = (a: PaneArrangement): PaneArrangement => ({
  ...a,
  subSplit: { ...a.subSplit },
  subBottomView: { ...a.subBottomView },
});

/** The app currently shown in a given pane half. */
export function appAt(
  a: PaneArrangement,
  pane: PaneKey,
  half: PaneHalf
): AppKey | null {
  if (half === "bottom") {
    return a.subSplit[pane] ? a.subBottomView[pane] : null;
  }
  return pane === "left" ? a.left : a[pane];
}

/** Places an app into a pane half, mutating the passed (already cloned) value. */
function setAppAt(
  a: PaneArrangement,
  pane: PaneKey,
  half: PaneHalf,
  app: AppKey
) {
  if (half === "bottom") {
    a.subSplit[pane] = true;
    a.subBottomView[pane] = app;
    return;
  }
  if (pane === "left") a.left = app;
  else a[pane] = app;
}

/** Columns that currently hold something, in visual order. */
const openColumns = (a: PaneArrangement): PaneKey[] =>
  COLUMNS.filter((c) => (c === "left" ? true : a[c] !== null));

/** First column with no app, or null when all three are in use. */
const firstFreeColumn = (a: PaneArrangement): PaneKey | null => {
  if (a.center === null) return "center";
  if (a.right === null) return "right";
  return null;
};

/** The open column immediately beside `target` on `side`, if any. */
function neighbourColumn(
  a: PaneArrangement,
  target: PaneKey,
  side: "left" | "right"
): PaneKey | null {
  const open = openColumns(a);
  const i = open.indexOf(target);
  if (i === -1) return null;
  return open[side === "left" ? i - 1 : i + 1] ?? null;
}

/**
 * Removes the dragged pane from where it came, after its app has been placed
 * elsewhere. Mirrors the promotion rules in Layout's `closeLeftPane` /
 * `closeHalf`: closing a half must never take its sibling with it.
 */
function clearSource(a: PaneArrangement, from: PaneKey, half: PaneHalf) {
  if (half === "bottom") {
    // Dropping the bottom half elsewhere just un-splits the column; the top
    // half keeps the column to itself.
    a.subSplit[from] = false;
    return;
  }
  if (a.subSplit[from]) {
    // The bottom half is promoted into the whole column.
    const promoted = a.subBottomView[from];
    a.subSplit[from] = false;
    if (from === "left") a.left = promoted;
    else a[from] = promoted;
    return;
  }
  // A whole column leaves. `left` is route-driven and can never be empty, so
  // callers must have converted that case into a swap before reaching here.
  if (from !== "left") a[from] = null;
}

/**
 * Would moving this pane away leave the routed column with nothing to show?
 * If so the caller swaps instead of moving — that keeps `left` populated and
 * avoids inventing a rule for "what fills the hole".
 */
const wouldEmptyLeft = (a: PaneArrangement, p: PaneDragPayload): boolean =>
  p.kind === "pane" &&
  p.from === "left" &&
  (p.half ?? "top") === "top" &&
  !a.subSplit.left;

/**
 * Resolves a drop into the next arrangement.
 *
 * - `center` replaces the target's app (for a pane drag: swaps the two).
 * - `top` / `bottom` stack the target column into halves, dragged app in the
 *   dropped-on half.
 * - `left` / `right` open a new column on that side, using the first free slot;
 *   with all three columns in use it falls back to replacing the pane on that
 *   side rather than doing nothing.
 *
 * Returns null when the drop is a no-op (dropped on itself, or unusable).
 */
export function applyPaneDrop(
  current: PaneArrangement,
  target: PaneKey,
  targetHalf: PaneHalf,
  zone: DropZone,
  payload: PaneDragPayload
): PaneDropResult | null {
  const sourceHalf: PaneHalf =
    payload.kind === "pane" ? (payload.half ?? "top") : "top";

  // Dropping a pane onto itself changes nothing.
  if (
    payload.kind === "pane" &&
    payload.from === target &&
    sourceHalf === targetHalf &&
    zone === "center"
  ) {
    return null;
  }

  const moving: AppKey | null =
    payload.kind === "app"
      ? payload.app
      : appAt(current, payload.from, sourceHalf);
  if (!moving) return null;

  const next = clone(current);
  const isPaneDrag = payload.kind === "pane";
  // Swapping keeps `left` populated without a special "what fills the hole" rule.
  const swapInsteadOfMove = isPaneDrag && wouldEmptyLeft(current, payload);

  const finish = (pane: PaneKey, half: PaneHalf): PaneDropResult => {
    const navigateTo = next.left !== current.left ? next.left : undefined;
    return { next, focus: { pane, half }, navigateTo };
  };

  if (zone === "center") {
    const displaced = appAt(current, target, targetHalf);
    setAppAt(next, target, targetHalf, moving);
    if (isPaneDrag) {
      // A centre drop always swaps: the displaced app takes the dragged pane's
      // place. Total by construction, so no column is ever left empty and the
      // "what fills the hole" question never arises.
      if (displaced) setAppAt(next, payload.from, sourceHalf, displaced);
      else clearSource(next, payload.from, sourceHalf);
    }
    return finish(target, targetHalf);
  }

  if (zone === "top" || zone === "bottom") {
    const existing = appAt(current, target, "top");
    if (!current.subSplit[target] && existing) {
      // Splitting for the first time: the column's current app keeps the half
      // the drop didn't land on.
      if (zone === "top") {
        setAppAt(next, target, "bottom", existing);
        setAppAt(next, target, "top", moving);
      } else {
        setAppAt(next, target, "bottom", moving);
      }
    } else {
      setAppAt(next, target, zone === "top" ? "top" : "bottom", moving);
      next.subSplit[target] = true;
    }
    if (isPaneDrag && !swapInsteadOfMove) {
      clearSource(next, payload.from, sourceHalf);
    }
    return finish(target, zone === "top" ? "top" : "bottom");
  }

  // zone === "left" | "right": a new column beside the target.
  const free = firstFreeColumn(current);
  if (free && !(isPaneDrag && payload.from === free)) {
    setAppAt(next, free, "top", moving);
    if (isPaneDrag && !swapInsteadOfMove) {
      clearSource(next, payload.from, sourceHalf);
    }
    return finish(free, "top");
  }

  // No room: replace the pane on that side (or the target itself at the end).
  const victim = neighbourColumn(current, target, zone) ?? target;
  const displaced = appAt(current, victim, "top");
  setAppAt(next, victim, "top", moving);
  if (isPaneDrag) {
    if (swapInsteadOfMove && displaced) {
      setAppAt(next, payload.from, sourceHalf, displaced);
    } else {
      clearSource(next, payload.from, sourceHalf);
    }
  }
  return finish(victim, "top");
}
