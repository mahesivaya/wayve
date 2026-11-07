type Scroller = Pick<
  HTMLElement,
  "scrollTop" | "scrollLeft" | "clientHeight" | "clientWidth"
>;

// Route one wheel/touchpad event over an HTML email's iframe (EmailBody.tsx).
// The frame is sized to its content's height, so vertical scroll belongs to
// the reading pane; but an email wider than the pane (fixed-width newsletter
// layouts) overflows the frame sideways, and only the frame's own document can
// scroll that. The browser's default is cancelled, so both axes are applied
// here: dropping the horizontal delta made a wide email movable only by its
// scrollbar arrows. Shift+wheel on a plain mouse wheel arrives as vertical
// delta with shiftKey set, and means sideways.
export function routeEmailWheel(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  pane: Scroller,
  frame: Scroller | null
): void {
  const unit = (size: number) =>
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size : 1;
  let dx = event.deltaX;
  let dy = event.deltaY;
  if (event.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  pane.scrollTop += dy * unit(pane.clientHeight);
  if (frame) frame.scrollLeft += dx * unit(frame.clientWidth);
}
