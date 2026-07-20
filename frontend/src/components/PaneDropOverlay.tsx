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
}: {
  onDrop: (zone: DropZone, payload: PaneDragPayload) => void;
  /**
   * False once all three columns are in use. A left/right drop then replaces
   * this pane instead of opening a column, so the preview must show the whole
   * pane rather than a sliver promising a column that can't be created.
   */
  canOpenNewColumn?: boolean;
}) {
  const [zone, setZone] = useState<DropZone | null>(null);

  const isEdge = zone === "left" || zone === "right";
  const shownZone: DropZone | null =
    zone && isEdge && !canOpenNewColumn ? "center" : zone;

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
