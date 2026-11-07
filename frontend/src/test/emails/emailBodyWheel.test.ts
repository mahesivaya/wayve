// Wheel/touchpad scroll over an HTML email: vertical moves the reading pane,
// horizontal moves the email itself (for emails wider than the pane).
import { describe, expect, it } from "vitest";
import { routeEmailWheel } from "../../emails/emailWheel";

const scroller = (clientHeight = 400, clientWidth = 500) => ({
  scrollTop: 0,
  scrollLeft: 0,
  clientHeight,
  clientWidth,
});

const wheel = (
  deltaX: number,
  deltaY: number,
  opts: { deltaMode?: number; shiftKey?: boolean } = {}
) => ({
  deltaX,
  deltaY,
  deltaMode: opts.deltaMode ?? 0,
  shiftKey: opts.shiftKey ?? false,
});

describe("routeEmailWheel", () => {
  it("scrolls the reading pane vertically", () => {
    const pane = scroller();
    const frame = scroller();
    routeEmailWheel(wheel(0, 120), pane, frame);

    expect(pane.scrollTop).toBe(120);
    expect(frame.scrollLeft).toBe(0);
  });

  // The regression: sideways scroll went to the pane, which can't scroll
  // sideways, so a wide email only moved with its scrollbar arrows.
  it("scrolls a wide email sideways in the frame, not the pane", () => {
    const pane = scroller();
    const frame = scroller();
    routeEmailWheel(wheel(80, 0), pane, frame);

    expect(frame.scrollLeft).toBe(80);
    expect(pane.scrollLeft).toBe(0);
    expect(pane.scrollTop).toBe(0);
  });

  it("applies both axes of a diagonal touchpad swipe", () => {
    const pane = scroller();
    const frame = scroller();
    routeEmailWheel(wheel(30, 50), pane, frame);

    expect(pane.scrollTop).toBe(50);
    expect(frame.scrollLeft).toBe(30);
  });

  it("treats Shift+wheel as sideways", () => {
    const pane = scroller();
    const frame = scroller();
    routeEmailWheel(wheel(0, 100, { shiftKey: true }), pane, frame);

    expect(frame.scrollLeft).toBe(100);
    expect(pane.scrollTop).toBe(0);
  });

  it("scales line and page deltas", () => {
    const pane = scroller(400, 500);
    const frame = scroller(400, 500);
    routeEmailWheel(wheel(1, 3, { deltaMode: 1 }), pane, frame);
    expect(pane.scrollTop).toBe(48);
    expect(frame.scrollLeft).toBe(16);

    const pane2 = scroller(400, 500);
    const frame2 = scroller(400, 500);
    routeEmailWheel(wheel(1, 1, { deltaMode: 2 }), pane2, frame2);
    expect(pane2.scrollTop).toBe(400);
    expect(frame2.scrollLeft).toBe(500);
  });
});
