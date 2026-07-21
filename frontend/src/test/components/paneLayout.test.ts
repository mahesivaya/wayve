// The drop rules for drag-to-split panes. These are the cases that are painful
// to reach by actually dragging — all three columns occupied, and moving the
// routed (left) pane, which can never be left empty.
import { describe, expect, it } from "vitest";
import { dropZoneFromPointer, EDGE_BAND } from "../../components/paneDnd";
import {
  applyPaneDrop,
  canOpenNewColumn,
  type PaneArrangement,
} from "../../components/paneLayout";

const RECT = { left: 0, top: 0, width: 400, height: 200 };

const base = (over: Partial<PaneArrangement> = {}): PaneArrangement => ({
  left: "emails",
  center: null,
  right: null,
  subSplit: { left: false, center: false, right: false },
  subBottomView: { left: "home", center: "home", right: "home" },
  ...over,
});

describe("dropZoneFromPointer", () => {
  it("returns centre well inside the pane", () => {
    expect(dropZoneFromPointer(RECT, 200, 100)).toBe("center");
  });

  it("returns the nearest edge inside the edge band", () => {
    expect(dropZoneFromPointer(RECT, 10, 100)).toBe("left");
    expect(dropZoneFromPointer(RECT, 390, 100)).toBe("right");
    expect(dropZoneFromPointer(RECT, 200, 5)).toBe("top");
    expect(dropZoneFromPointer(RECT, 200, 195)).toBe("bottom");
  });

  it("prefers the closer axis in a corner", () => {
    // 8px from the left, 20px from the top -> left wins.
    expect(dropZoneFromPointer(RECT, 8, 20)).toBe("left");
    // 60px from the left, 4px from the top -> top wins.
    expect(dropZoneFromPointer(RECT, 60, 4)).toBe("top");
  });

  it("treats just inside the band as an edge and just outside as centre", () => {
    const insideX = RECT.width * EDGE_BAND - 1;
    const outsideX = RECT.width * EDGE_BAND + 1;
    expect(dropZoneFromPointer(RECT, insideX, 100)).toBe("left");
    expect(dropZoneFromPointer(RECT, outsideX, 100)).toBe("center");
  });

  it("does not divide by zero on a collapsed pane", () => {
    expect(
      dropZoneFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)
    ).toBe("center");
  });
});

describe("applyPaneDrop — dragging an app from the sidebar", () => {
  it("replaces the pane's app on a centre drop", () => {
    const r = applyPaneDrop(base(), "left", "top", "center", {
      kind: "app",
      app: "chat",
    });
    expect(r?.next.left).toBe("chat");
    // The routed column changed, so the caller has to navigate.
    expect(r?.navigateTo).toBe("chat");
  });

  it("opens the second column on an edge drop", () => {
    const r = applyPaneDrop(base(), "left", "top", "right", {
      kind: "app",
      app: "chat",
    });
    expect(r?.next.right).toBe("chat");
    expect(r?.next.left).toBe("emails"); // untouched
    expect(r?.navigateTo).toBeUndefined();
    expect(r?.focus).toEqual({ pane: "right", half: "top" });
  });

  it("caps the layout at two columns", () => {
    // Second column already open: another edge drop must not open a third, it
    // replaces the pane being pointed at instead.
    const a = base({ right: "tasks" });
    const r = applyPaneDrop(a, "left", "top", "right", {
      kind: "app",
      app: "chat",
    });
    expect(r?.next.center).toBeNull(); // never used
    expect(r?.next.right).toBe("tasks"); // untouched — not the one hovered
    expect(r?.next.left).toBe("chat"); // the hovered pane is replaced
  });

  it("reports when no new column can be opened", () => {
    expect(canOpenNewColumn(base())).toBe(true);
    expect(canOpenNewColumn(base({ right: "tasks" }))).toBe(false);
  });

  it("replaces the half instead of splitting a pane that's already split", () => {
    // The left column is already two halves (emails over tasks). A top/bottom
    // drop can't split it further, so it replaces the half under the cursor.
    const a = base({
      subSplit: { left: true, center: false, right: false },
      subBottomView: { left: "tasks", center: "home", right: "home" },
    });
    const bottom = applyPaneDrop(a, "left", "bottom", "bottom", {
      kind: "app",
      app: "chat",
    });
    expect(bottom?.next.subBottomView.left).toBe("chat"); // bottom half replaced
    expect(bottom?.next.left).toBe("emails"); // top half untouched
    expect(bottom?.next.subSplit.left).toBe(true); // still split, not un-split

    const top = applyPaneDrop(a, "left", "top", "top", {
      kind: "app",
      app: "chat",
    });
    expect(top?.next.left).toBe("chat"); // top half replaced
    expect(top?.next.subBottomView.left).toBe("tasks"); // bottom untouched
    expect(top?.navigateTo).toBe("chat");
  });

  it("stacks into halves, keeping the existing app in the other half", () => {
    const bottom = applyPaneDrop(base(), "left", "top", "bottom", {
      kind: "app",
      app: "chat",
    });
    expect(bottom?.next.subSplit.left).toBe(true);
    expect(bottom?.next.left).toBe("emails"); // stays on top
    expect(bottom?.next.subBottomView.left).toBe("chat");

    const top = applyPaneDrop(base(), "left", "top", "top", {
      kind: "app",
      app: "chat",
    });
    expect(top?.next.subSplit.left).toBe(true);
    expect(top?.next.left).toBe("chat"); // dragged app takes the top
    expect(top?.next.subBottomView.left).toBe("emails"); // existing pushed down
    expect(top?.navigateTo).toBe("chat");
  });
});

describe("applyPaneDrop — rearranging an open pane", () => {
  // `right` is the second column; `center` is never populated under the
  // two-column cap, so these all describe reachable arrangements.
  const twoColumns = base({ right: "chat" });

  it("swaps two columns on a centre drop", () => {
    const r = applyPaneDrop(twoColumns, "left", "top", "center", {
      kind: "pane",
      from: "right",
      half: "top",
    });
    expect(r?.next.left).toBe("chat");
    expect(r?.next.right).toBe("emails");
    expect(r?.navigateTo).toBe("chat");
  });

  it("is a no-op when dropped on itself", () => {
    expect(
      applyPaneDrop(twoColumns, "right", "top", "center", {
        kind: "pane",
        from: "right",
        half: "top",
      })
    ).toBeNull();
  });

  it("moving a column into the other pane's half empties it", () => {
    const r = applyPaneDrop(twoColumns, "left", "top", "bottom", {
      kind: "pane",
      from: "right",
      half: "top",
    });
    expect(r?.next.right).toBeNull(); // vacated
    expect(r?.next.subSplit.left).toBe(true);
    expect(r?.next.subBottomView.left).toBe("chat");
    expect(r?.next.left).toBe("emails");
  });

  it("never empties the routed column — it swaps instead of moving", () => {
    // Dragging the left pane into the other column's bottom half would
    // otherwise leave the routed column with nothing to render.
    const r = applyPaneDrop(twoColumns, "right", "top", "bottom", {
      kind: "pane",
      from: "left",
      half: "top",
    });
    expect(r?.next.left).not.toBeNull();
    expect(r?.next.subBottomView.right).toBe("emails");
  });

  it("promotes the bottom half when the top half is dragged out", () => {
    const a = base({
      right: "chat",
      subSplit: { left: false, center: false, right: true },
      subBottomView: { left: "home", center: "home", right: "tasks" },
    });
    const r = applyPaneDrop(a, "left", "top", "bottom", {
      kind: "pane",
      from: "right",
      half: "top",
    });
    // chat moved into the left column's lower half; tasks takes over the whole
    // right column.
    expect(r?.next.subBottomView.left).toBe("chat");
    expect(r?.next.right).toBe("tasks");
    expect(r?.next.subSplit.right).toBe(false);
  });

  it("dragging out the bottom half just un-splits the column", () => {
    const a = base({
      right: "chat",
      subSplit: { left: false, center: false, right: true },
      subBottomView: { left: "home", center: "home", right: "tasks" },
    });
    const r = applyPaneDrop(a, "left", "top", "bottom", {
      kind: "pane",
      from: "right",
      half: "bottom",
    });
    expect(r?.next.subSplit.right).toBe(false);
    expect(r?.next.right).toBe("chat"); // top half keeps the column
    expect(r?.next.subBottomView.left).toBe("tasks");
  });
});
