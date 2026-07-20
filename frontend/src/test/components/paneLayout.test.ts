// The drop rules for drag-to-split panes. These are the cases that are painful
// to reach by actually dragging — all three columns occupied, and moving the
// routed (left) pane, which can never be left empty.
import { describe, expect, it } from "vitest";
import { dropZoneFromPointer, EDGE_BAND } from "../../components/paneDnd";
import {
  applyPaneDrop,
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

  it("opens the first free column on an edge drop", () => {
    const r = applyPaneDrop(base(), "left", "top", "right", {
      kind: "app",
      app: "chat",
    });
    expect(r?.next.center).toBe("chat");
    expect(r?.next.left).toBe("emails"); // untouched
    expect(r?.navigateTo).toBeUndefined();
    expect(r?.focus).toEqual({ pane: "center", half: "top" });
  });

  it("uses the right column once center is taken", () => {
    const r = applyPaneDrop(base({ center: "notes" }), "center", "top", "right", {
      kind: "app",
      app: "chat",
    });
    expect(r?.next.right).toBe("chat");
    expect(r?.next.center).toBe("notes");
  });

  it("replaces the neighbour when all three columns are in use", () => {
    const a = base({ center: "notes", right: "tasks" });
    const r = applyPaneDrop(a, "center", "top", "right", {
      kind: "app",
      app: "chat",
    });
    // No free slot -> the pane to the right of center is replaced.
    expect(r?.next.right).toBe("chat");
    expect(r?.next.center).toBe("notes");
    expect(r?.next.left).toBe("emails");
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
  it("swaps two columns on a centre drop", () => {
    const a = base({ center: "chat" });
    const r = applyPaneDrop(a, "left", "top", "center", {
      kind: "pane",
      from: "center",
      half: "top",
    });
    expect(r?.next.left).toBe("chat");
    expect(r?.next.center).toBe("emails");
    expect(r?.navigateTo).toBe("chat");
  });

  it("is a no-op when dropped on itself", () => {
    const a = base({ center: "chat" });
    expect(
      applyPaneDrop(a, "center", "top", "center", {
        kind: "pane",
        from: "center",
        half: "top",
      })
    ).toBeNull();
  });

  it("moving a column away empties it", () => {
    const a = base({ center: "chat", right: "tasks" });
    const r = applyPaneDrop(a, "right", "top", "bottom", {
      kind: "pane",
      from: "center",
      half: "top",
    });
    expect(r?.next.center).toBeNull(); // vacated
    expect(r?.next.subSplit.right).toBe(true);
    expect(r?.next.subBottomView.right).toBe("chat");
    expect(r?.next.right).toBe("tasks");
  });

  it("never empties the routed column — it swaps instead of moving", () => {
    const a = base({ center: "chat" });
    // Dragging the left pane onto the centre pane's bottom edge would otherwise
    // leave the routed column with nothing to render.
    const r = applyPaneDrop(a, "center", "top", "bottom", {
      kind: "pane",
      from: "left",
      half: "top",
    });
    expect(r?.next.left).not.toBeNull();
    expect(r?.next.subBottomView.center).toBe("emails");
  });

  it("promotes the bottom half when the top half is dragged out", () => {
    const a = base({
      center: "chat",
      subSplit: { left: false, center: true, right: false },
      subBottomView: { left: "home", center: "tasks", right: "home" },
    });
    const r = applyPaneDrop(a, "left", "top", "right", {
      kind: "pane",
      from: "center",
      half: "top",
    });
    // chat moved out to a new column; tasks takes over the whole center column.
    expect(r?.next.center).toBe("tasks");
    expect(r?.next.subSplit.center).toBe(false);
    expect(r?.next.right).toBe("chat");
  });

  it("dragging out the bottom half just un-splits the column", () => {
    const a = base({
      center: "chat",
      subSplit: { left: false, center: true, right: false },
      subBottomView: { left: "home", center: "tasks", right: "home" },
    });
    const r = applyPaneDrop(a, "left", "top", "right", {
      kind: "pane",
      from: "center",
      half: "bottom",
    });
    expect(r?.next.subSplit.center).toBe(false);
    expect(r?.next.center).toBe("chat"); // top half keeps the column
    expect(r?.next.right).toBe("tasks");
  });
});
