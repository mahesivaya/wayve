import { useState, type DragEvent } from "react";
import {
  dropZoneFromPointer,
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
}) {
  const [zone, setZone] = useState<DropZone | null>(null);

  // Preview the fallback the reducer will actually apply (applyPaneDrop
  // normalises the same two cases to a replace), so what you see is what lands.
  const blockedHorizontally =
    (zone === "left" || zone === "right") && !canOpenNewColumn;
  const blockedVertically =
    (zone === "top" || zone === "bottom") && !canSplitVertically;
  const shownZone: DropZone | null =
    zone && (blockedHorizontally || blockedVertically) ? "center" : zone;

  const zoneFor = (e: DragEvent<HTMLDivElement>): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    return dropZoneFromPointer(rect, e.clientX, e.clientY);
  };

  return (
    <div
      className="pane-drop-overlay"
      onDragOver={(e) => {
        // During dragover only `types` is readable, not the payload itself.
        if (!hasPaneDragData(e.dataTransfer)) return;
        e.preventDefault(); // required, or the browser refuses the drop
        e.dataTransfer.dropEffect = "move";
        setZone(zoneFor(e));
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
