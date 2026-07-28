import type { AppKey } from "./LayoutConfig";
import type { DropZone, PaneDragPayload, PaneHalf, PaneKey } from "./paneDnd";

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

/**
 * The layout is capped at two columns and two rows — four panes. The vertical
 * cap is structural (a pane splits into exactly two halves); this is the
 * horizontal one.
 *
 * `right` is the second column rather than `center`; `center` is left
 * permanently empty, kept only so a persisted arrangement from before the cap
 * still renders.
 */
const firstFreeColumn = (a: PaneArrangement): PaneKey | null =>
  a.right === null ? "right" : null;

/**
 * True while a left/right drop can still open a *new* column. Once all three
 * are in use an edge drop degrades to replacing the pane under the cursor, and
 * the overlay must stop previewing a new column that can't be created.
 */
export const canOpenNewColumn = (a: PaneArrangement): boolean =>
  firstFreeColumn(a) !== null;

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

  // A split that can't actually be created degrades to a replace, so the two
  // axes stay symmetric: a pane already split into two halves can't split
  // vertically again, and with both columns open nothing can split
  // horizontally. In both cases the drop replaces the pane under the cursor
  // instead of silently doing something else. `effectiveZone` is what the drop
  // really does; the overlay previews the same fallback (see canSplitVertically
  // / canOpenNewColumn on PaneDropOverlay).
  let effectiveZone: DropZone = zone;
  if ((zone === "top" || zone === "bottom") && current.subSplit[target]) {
    effectiveZone = "center";
  } else if (
    (zone === "left" || zone === "right") &&
    !canOpenNewColumn(current)
  ) {
    effectiveZone = "center";
  }

  // Dropping a pane onto itself changes nothing.
  if (
    payload.kind === "pane" &&
    payload.from === target &&
    sourceHalf === targetHalf &&
    effectiveZone === "center"
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

  if (effectiveZone === "center") {
    // Replace the pane under the cursor. For a pane drag this swaps: the
    // displaced app takes the dragged pane's place — total by construction, so
    // no column is ever left empty and "what fills the hole" never arises.
    const displaced = appAt(current, target, targetHalf);
    setAppAt(next, target, targetHalf, moving);
    if (isPaneDrag) {
      if (displaced) setAppAt(next, payload.from, sourceHalf, displaced);
      else clearSource(next, payload.from, sourceHalf);
    }
    return finish(target, targetHalf);
  }

  if (effectiveZone === "top" || effectiveZone === "bottom") {
    // Reachable only when the target isn't already split (else it was
    // normalised to "center" above), so this always creates the split.
    const existing = appAt(current, target, "top");
    if (existing) {
      // The column's current app keeps the half the drop didn't land on.
      if (effectiveZone === "top") {
        setAppAt(next, target, "bottom", existing);
        setAppAt(next, target, "top", moving);
      } else {
        setAppAt(next, target, "bottom", moving);
      }
    } else {
      setAppAt(next, target, effectiveZone, moving);
      next.subSplit[target] = true;
    }
    if (isPaneDrag && !swapInsteadOfMove) {
      clearSource(next, payload.from, sourceHalf);
    }
    return finish(target, effectiveZone);
  }

  // effectiveZone is "left" | "right": open a new column. Reachable only when a
  // column is free (else normalised to "center"), so firstFreeColumn is set.
  const free = firstFreeColumn(current) ?? target;
  setAppAt(next, free, "top", moving);
  if (isPaneDrag && !swapInsteadOfMove) {
    clearSource(next, payload.from, sourceHalf);
  }
  return finish(free, "top");
}
