// Phones: an email built wider than the screen (most newsletters are 600px+)
// is shrunk to fit, as the Gmail app does, instead of scrolling sideways.
// Wider screens keep the sideways scroll (see routeEmailWheel).
export const FIT_WIDTH_QUERY = "(max-width: 700px)";
// Below this the text is unreadable anyway; pinch-zoom covers the rest.
const MIN_FIT_ZOOM = 0.4;

// The zoom that makes `doc`'s content fit its frame's width, or 1 when it
// already fits. `zoom` (not a transform) so layout, link hit-testing and the
// measured height all follow the scaled size.
export function fitZoom(doc: Document): number {
  const root = doc.documentElement;
  const body = doc.body;
  if (!root || !body) return 1;
  body.style.removeProperty("zoom");
  const contentWidth = root.scrollWidth;
  const frameWidth = root.clientWidth;
  if (frameWidth <= 0 || contentWidth <= frameWidth + 1) return 1;
  return Math.max(MIN_FIT_ZOOM, frameWidth / contentWidth);
}
