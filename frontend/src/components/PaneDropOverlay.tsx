import { useState, type DragEvent } from "react";
import {
  dropZoneFromPointer,
  tabDropZoneFromPointer,
  hasPaneDragData,
  readPaneDragData,
  type DropZone,
  type PaneDragPayload,
} from "./paneDnd";

// Drop target covering one pane (or one half of a sub-split pane) during a
// drag. Rendered ONLY while a pane drag is in flight, so it never sits over the
// page swallowing ordinary clicks.
//
// It ignores drags that aren't ours — Drive and Documents bind onDrop to upload
// OS files, and those must keep working while this is mounted.
export default function PaneDropOverlay({
  onDrop,
  canOpenNewColumn = true,
  canSplitVertically = true,
  mode = "zones",
}: {
  onDrop: (zone: DropZone, payload: PaneDragPayload) => void;
  /**
   * False once both columns are in use. A left/right drop then replaces this
   * pane instead of opening a column, so the preview shows the whole pane
   * rather than a sliver promising a column that can't be created.
   */
  canOpenNewColumn?: boolean;
  /**
   * False when this pane is already split into two halves. A top/bottom drop
   * then replaces the half instead of splitting again, so the preview shows the
   * whole pane rather than promising a split that can't happen.
   */
  canSplitVertically?: boolean;
  /**
   * Tab drags (Cursor-style editor groups):
   * - "half": only the right half is a target — dragging a tab past the middle
   *   of the main page sends it to the right group; the left half ignores it.
   * - "whole": the entire pane is one target (dropping a tab onto a group).
   * - "zones" (default): edge/centre zones for app and pane drags.
   */
  mode?: "zones" | "half" | "whole";
}) {
  const [zone, setZone] = useState<DropZone | null>(null);

  // Preview the fallback the reducer will actually apply (applyPaneDrop
  // normalises the same two cases to a replace), so what you see is what lands.
  const blockedHorizontally =
    (zone === "left" || zone === "right") && !canOpenNewColumn;
  const blockedVertically =
    (zone === "top" || zone === "bottom") && !canSplitVertically;
  // Tab drops never split further or replace, so they preview as-is.
  const shownZone: DropZone | null =
    mode === "zones" && zone && (blockedHorizontally || blockedVertically)
      ? "center"
      : zone;

  const zoneFor = (e: DragEvent<HTMLDivElement>): DropZone | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (mode === "whole") return "center";
    if (mode === "half") return tabDropZoneFromPointer(rect, e.clientX);
    return dropZoneFromPointer(rect, e.clientX, e.clientY);
  };

  return (
    <div
      className="pane-drop-overlay"
      onDragOver={(e) => {
        // During dragover only `types` is readable, not the payload itself.
        if (!hasPaneDragData(e.dataTransfer)) return;
        const next = zoneFor(e);
        setZone(next);
        if (!next) return; // not past the middle yet: no drop here
        e.preventDefault(); // required, or the browser refuses the drop
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(e) => {
        // Ignore bubbling from the highlight child, which would otherwise
        // flicker the preview off on every pointer move.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setZone(null);
      }}
      onDrop={(e) => {
        const payload = readPaneDragData(e.dataTransfer);
        if (!payload) return;
        e.preventDefault();
        e.stopPropagation();
        const target = zoneFor(e);
        setZone(null);
        if (!target) return;
        onDrop(target, payload);
      }}
    >
      {shownZone && (
        <div
          className={`pane-drop-hint pane-drop-hint--${shownZone}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
